/**
 * Review Assistant Extension
 *
 * Helps you review a pull request by checking out the PR branch, fetching the
 * full diff and metadata, and injecting everything into the LLM's context so
 * you can ask targeted questions about the changes.
 *
 * Commands:
 *   /review <number>   - Check out PR #<number>, load diff into LLM context,
 *                        and get an initial summary of the changes.
 *   /review-done       - End the review session and clear injected context.
 *   /review-status     - Show details about the currently active PR review.
 *
 * Workflow:
 *   1. Open pi from within the git repository you want to review.
 *   2. Run `/review 42` (where 42 is the PR number).
 *   3. The extension checks out the branch, pulls the diff, and fires an
 *      initial analysis into the chat.
 *   4. Ask any follow-up questions: "Why did they change X?", "Is this
 *      approach safe?", "What are the performance implications?", etc.
 *   5. Run `/review-done` when finished.
 *
 * Requirements: `gh` CLI (https://cli.github.com/) authenticated and available
 * on PATH.
 *
 * Placement: ~/.pi/agent/extensions/review-assistant.ts  (global)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────────

interface PRMeta {
	number: number;
	title: string;
	body: string;
	authorLogin: string;
	baseRefName: string;
	headRefName: string;
	state: string;
	isDraft: boolean;
	additions: number;
	deletions: number;
	changedFiles: number;
	url: string;
	commits: number;
}

interface ActiveReview {
	pr: PRMeta;
	diff: string;
	diffTruncated: boolean;
	/** The cwd where the review was started */
	cwd: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Maximum characters of diff to inject into the system prompt. */
const MAX_DIFF_CHARS = 40_000;

async function run(
	pi: ExtensionAPI,
	cmd: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
	return pi.exec(cmd, args, { timeout: 30_000 });
}

async function ghAvailable(pi: ExtensionAPI): Promise<boolean> {
	const r = await run(pi, "gh", ["--version"]);
	return r.code === 0;
}

async function fetchPRMeta(pi: ExtensionAPI, prNumber: number): Promise<PRMeta | null> {
	const r = await run(pi, "gh", [
		"pr",
		"view",
		String(prNumber),
		"--json",
		[
			"number",
			"title",
			"body",
			"author",
			"baseRefName",
			"headRefName",
			"state",
			"isDraft",
			"additions",
			"deletions",
			"changedFiles",
			"url",
			"commits",
		].join(","),
	]);
	if (r.code !== 0) return null;

	let raw: any;
	try {
		raw = JSON.parse(r.stdout);
	} catch {
		return null;
	}

	return {
		number: raw.number ?? prNumber,
		title: raw.title ?? "",
		body: raw.body ?? "",
		authorLogin: raw.author?.login ?? "unknown",
		baseRefName: raw.baseRefName ?? "",
		headRefName: raw.headRefName ?? "",
		state: raw.state ?? "UNKNOWN",
		isDraft: raw.isDraft ?? false,
		additions: raw.additions ?? 0,
		deletions: raw.deletions ?? 0,
		changedFiles: raw.changedFiles ?? 0,
		url: raw.url ?? "",
		commits: Array.isArray(raw.commits) ? raw.commits.length : (raw.commits ?? 0),
	};
}

async function checkoutPR(pi: ExtensionAPI, prNumber: number): Promise<{ ok: boolean; stderr: string }> {
	const r = await run(pi, "gh", ["pr", "checkout", String(prNumber)]);
	return { ok: r.code === 0, stderr: r.stderr };
}

async function fetchDiff(
	pi: ExtensionAPI,
	prNumber: number,
): Promise<{ diff: string; truncated: boolean }> {
	const r = await run(pi, "gh", ["pr", "diff", String(prNumber)]);
	if (r.code !== 0) return { diff: "", truncated: false };

	const full = r.stdout;
	if (full.length <= MAX_DIFF_CHARS) {
		return { diff: full, truncated: false };
	}

	// Truncate at the last complete hunk header before the limit so we don't
	// cut mid-line in a confusing place.
	const slice = full.slice(0, MAX_DIFF_CHARS);
	const lastHunk = slice.lastIndexOf("\n@@");
	const safeSlice = lastHunk > 0 ? slice.slice(0, lastHunk) : slice;

	return { diff: safeSlice, truncated: true };
}

function buildStatusText(review: ActiveReview, theme: ExtensionContext["ui"]["theme"]): string {
	const badge = review.pr.isDraft ? " [DRAFT]" : "";
	const pr = theme.fg("accent", `PR #${review.pr.number}`);
	const title = theme.fg(
		"dim",
		` ${review.pr.title.length > 45 ? review.pr.title.slice(0, 42) + "…" : review.pr.title}${badge}`,
	);
	const stats = theme.fg("muted", ` +${review.pr.additions}/-${review.pr.deletions}`);
	return `🔍 ${pr}${title}${stats}`;
}

function buildSystemPromptBlock(review: ActiveReview): string {
	const pr = review.pr;

	const diffBlock = review.diff
		? [
				"",
				"### Full Diff",
				"",
				"```diff",
				review.diff,
				"```",
				...(review.diffTruncated
					? [
							"",
							`> ⚠️  Diff truncated at ${MAX_DIFF_CHARS.toLocaleString()} characters.`,
							"> Use your `bash` tool (e.g. `git diff origin/${pr.baseRefName}...HEAD -- <path>`) or",
							"> the `read` tool to examine specific files in full.",
						]
					: []),
			].join("\n")
		: "\n> ℹ️  No diff available — use `bash` or `read` to explore the branch.";

	return `

---
## 🔍 Active PR Review Context

You are acting as a **code review assistant**. The developer has checked out the branch for the
pull request below and wants your help analysing and understanding the changes.

**PR #${pr.number}${pr.isDraft ? " [DRAFT]" : ""}:** ${pr.title}
**Author:** @${pr.authorLogin}
**URL:** ${pr.url}
**Branch:** \`${pr.baseRefName}\` ← \`${pr.headRefName}\`
**Stats:** +${pr.additions} / -${pr.deletions} lines across ${pr.changedFiles} file(s) in ${pr.commits} commit(s)

### PR Description
${pr.body?.trim() ? pr.body.trim() : "_No description provided._"}
${diffBlock}

### Review Assistant Guidelines
- Reference specific file paths and line numbers from the diff when answering questions.
- Use the \`read\` tool to load the full content of any file that needs deeper analysis.
- Use \`bash\` to run \`git log\`, \`git blame\`, or other git commands for historical context.
- If asked about test coverage, look for existing test files alongside the changed files.
- Be concise but precise — the developer is in review mode and wants actionable insight.
---
`;
}

function buildInitialPrompt(review: ActiveReview): string {
	const pr = review.pr;
	const draftNote = pr.isDraft ? " *(draft)*" : "";
	return (
		`I've checked out **PR #${pr.number}**${draftNote} — *"${pr.title}"* by @${pr.authorLogin}.\n\n` +
		`**Stats:** +${pr.additions} / -${pr.deletions} across ${pr.changedFiles} file(s) · ${pr.commits} commit(s)\n` +
		`**Branch:** \`${pr.baseRefName}\` ← \`${pr.headRefName}\`\n\n` +
		`Please analyse the diff and give me an initial review summary covering:\n` +
		`1. **What this PR does** — a plain-language description of the intent and scope\n` +
		`2. **Key changes** — the most significant files and what changed in each\n` +
		`3. **Areas to scrutinise** — anything that warrants a closer look: logic complexity, ` +
		`missing error handling, security, performance, test coverage, or surprising patterns\n\n` +
		`I'll ask follow-up questions as I work through the review.`
	);
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function reviewAssistantExtension(pi: ExtensionAPI) {
	let activeReview: ActiveReview | null = null;

	// ── Persist / restore state ──────────────────────────────────────────────

	function persistState() {
		pi.appendEntry("review-assistant-state", activeReview);
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getBranch();
		activeReview = null;
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === "review-assistant-state") {
				// Last matching entry wins (most recent state).
				activeReview = (entry.data as ActiveReview) ?? null;
			}
		}
		updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext) {
		if (activeReview) {
			ctx.ui.setStatus("review-assistant", buildStatusText(activeReview, ctx.ui.theme));
		} else {
			ctx.ui.setStatus("review-assistant", undefined);
		}
	}

	// ── Session events ───────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("review-assistant", undefined);
	});

	// ── System prompt injection ──────────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (!activeReview) return undefined;
		return {
			systemPrompt: event.systemPrompt + buildSystemPromptBlock(activeReview),
		};
	});

	// ── /review <number> ─────────────────────────────────────────────────────

	pi.registerCommand("review", {
		description: "Start reviewing a PR: /review <number>",
		handler: async (args, ctx) => {
			const prNumber = parseInt(args.trim(), 10);
			if (isNaN(prNumber) || prNumber <= 0) {
				ctx.ui.notify("Usage: /review <PR number>  e.g. /review 42", "warning");
				return;
			}

			// Guard: check gh is available
			if (!(await ghAvailable(pi))) {
				ctx.ui.notify(
					"GitHub CLI (gh) not found. Install it from https://cli.github.com/ and authenticate.",
					"error",
				);
				return;
			}

			// If there's an active review, confirm before overwriting
			if (activeReview) {
				const proceed = await ctx.ui.confirm(
					`Already reviewing PR #${activeReview.pr.number}`,
					`Switch to PR #${prNumber}? The current review context will be replaced.`,
				);
				if (!proceed) return;
			}

			// ── Step 1: Fetch metadata ──
			ctx.ui.notify(`Fetching PR #${prNumber}…`, "info");
			const meta = await fetchPRMeta(pi, prNumber);
			if (!meta) {
				ctx.ui.notify(
					`Could not fetch PR #${prNumber}. Make sure the number is correct and gh is authenticated.`,
					"error",
				);
				return;
			}

			// Warn if PR is closed/merged — still allow it for post-merge review
			if (meta.state !== "OPEN") {
				const proceed = await ctx.ui.confirm(
					`PR #${prNumber} is ${meta.state}`,
					`This PR is not open. Check it out anyway for review?`,
				);
				if (!proceed) return;
			}

			// ── Step 2: Check out the branch ──
			ctx.ui.notify(`Checking out PR #${prNumber}: "${meta.title}"…`, "info");
			const checkout = await checkoutPR(pi, prNumber);
			if (!checkout.ok) {
				ctx.ui.notify(
					`Checkout failed: ${checkout.stderr || "unknown error"}`,
					"error",
				);
				return;
			}

			// ── Step 3: Fetch the diff ──
			ctx.ui.notify("Fetching diff…", "info");
			const { diff, truncated } = await fetchDiff(pi, prNumber);

			// ── Step 4: Activate review ──
			activeReview = {
				pr: meta,
				diff,
				diffTruncated: truncated,
				cwd: ctx.cwd,
			};

			persistState();
			updateStatus(ctx);

			if (truncated) {
				ctx.ui.notify(
					`Diff truncated to ${MAX_DIFF_CHARS.toLocaleString()} chars (PR is large). ` +
						"Use bash/read tools for full file content.",
					"warning",
				);
			}

			// Set a session name so it's easy to find in /resume
			pi.setSessionName(`Review PR #${meta.number}: ${meta.title}`);

			// ── Step 5: Kick off initial analysis ──
			ctx.ui.notify(`✓ PR #${prNumber} ready. Requesting initial analysis…`, "info");
			pi.sendUserMessage(buildInitialPrompt(activeReview), { deliverAs: "followUp" });
		},
	});

	// ── /review-done ─────────────────────────────────────────────────────────

	pi.registerCommand("review-done", {
		description: "End the current PR review session",
		handler: async (_args, ctx) => {
			if (!activeReview) {
				ctx.ui.notify("No active PR review. Use /review <number> to start.", "info");
				return;
			}

			const prNum = activeReview.pr.number;
			const prTitle = activeReview.pr.title;

			activeReview = null;
			persistState();
			updateStatus(ctx);

			ctx.ui.notify(`Review of PR #${prNum} "${prTitle}" ended.`, "info");
		},
	});

	// ── /review-status ───────────────────────────────────────────────────────

	pi.registerCommand("review-status", {
		description: "Show details about the active PR review",
		handler: async (_args, ctx) => {
			if (!activeReview) {
				ctx.ui.notify("No active PR review. Use /review <number> to start.", "info");
				return;
			}

			const { pr, diffTruncated, diff } = activeReview;
			const diffKb = (diff.length / 1024).toFixed(1);
			const draftBadge = pr.isDraft ? " [DRAFT]" : "";

			ctx.ui.notify(
				[
					`PR #${pr.number}${draftBadge}: ${pr.title}`,
					`Author:  @${pr.authorLogin}`,
					`Branch:  ${pr.baseRefName} ← ${pr.headRefName}`,
					`Changes: +${pr.additions} / -${pr.deletions} across ${pr.changedFiles} file(s), ${pr.commits} commit(s)`,
					`Diff:    ${diffKb} KB loaded${diffTruncated ? " (truncated)" : ""}`,
					`URL:     ${pr.url}`,
				].join("\n"),
				"info",
			);
		},
	});
}
