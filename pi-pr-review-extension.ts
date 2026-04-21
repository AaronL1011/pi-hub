/**
 * PR Review Q&A Extension
 *
 * Collects comments and replies from the open/draft PR for the current branch,
 * generates 3 AI recommendations for each thread, then walks you through a
 * Q&A wizard where you pick a recommendation or write a custom instruction.
 *
 * Usage: /pr-review
 */

import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

interface ReviewComment {
	id: number;
	body: string;
	path: string | null;
	line: number | null;
	diffHunk: string | null;
	user: string;
	createdAt: string;
	inReplyToId: number | null;
	reviewId: number | null;
}

interface IssueComment {
	id: number;
	body: string;
	user: string;
	createdAt: string;
}

interface CommentThread {
	id: number;
	path: string | null;
	line: number | null;
	diffHunk: string | null;
	comments: { user: string; body: string; createdAt: string }[];
}

interface Recommendation {
	label: string;
	instruction: string;
}

interface ThreadWithRecs {
	thread: CommentThread;
	recommendations: Recommendation[];
}

interface ThreadAnswer {
	threadIndex: number;
	path: string | null;
	line: number | null;
	summary: string;
	instruction: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function exec(
	pi: ExtensionAPI,
	cmd: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
	return pi.exec(cmd, args, { timeout: 15_000 });
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const r = await exec(pi, "git", ["branch", "--show-current"]);
	return r.code === 0 ? r.stdout.trim() : null;
}

interface PRInfo {
	number: number;
	title: string;
	state: string;
	isDraft: boolean;
}

async function getPRForBranch(pi: ExtensionAPI, branch: string): Promise<PRInfo | null> {
	const r = await exec(pi, "gh", [
		"pr",
		"list",
		"--head",
		branch,
		"--state",
		"open",
		"--json",
		"number,title,state,isDraft",
		"--limit",
		"1",
	]);
	if (r.code !== 0) return null;
	const prs: PRInfo[] = JSON.parse(r.stdout);
	return prs[0] ?? null;
}

async function getReviewComments(pi: ExtensionAPI, prNumber: number): Promise<ReviewComment[]> {
	const r = await exec(pi, "gh", [
		"api",
		`repos/{owner}/{repo}/pulls/${prNumber}/comments`,
		"--paginate",
	]);
	if (r.code !== 0) return [];
	const raw: any[] = JSON.parse(r.stdout);
	return raw.map((c) => ({
		id: c.id,
		body: c.body ?? "",
		path: c.path ?? null,
		line: c.line ?? c.original_line ?? null,
		diffHunk: c.diff_hunk ?? null,
		user: c.user?.login ?? "unknown",
		createdAt: c.created_at ?? "",
		inReplyToId: c.in_reply_to_id ?? null,
		reviewId: c.pull_request_review_id ?? null,
	}));
}

async function getIssueComments(pi: ExtensionAPI, prNumber: number): Promise<IssueComment[]> {
	const r = await exec(pi, "gh", [
		"pr",
		"view",
		String(prNumber),
		"--json",
		"comments",
	]);
	if (r.code !== 0) return [];
	const data = JSON.parse(r.stdout);
	return (data.comments ?? []).map((c: any) => ({
		id: c.id ?? 0,
		body: c.body ?? "",
		user: c.author?.login ?? "unknown",
		createdAt: c.createdAt ?? "",
	}));
}

function buildThreads(reviewComments: ReviewComment[], issueComments: IssueComment[]): CommentThread[] {
	const threads: CommentThread[] = [];

	const rootComments = reviewComments.filter((c) => c.inReplyToId === null);
	const replyMap = new Map<number, ReviewComment[]>();
	for (const c of reviewComments) {
		if (c.inReplyToId !== null) {
			const replies = replyMap.get(c.inReplyToId) ?? [];
			replies.push(c);
			replyMap.set(c.inReplyToId, replies);
		}
	}

	for (const root of rootComments) {
		const replies = replyMap.get(root.id) ?? [];
		const allInThread = [root, ...replies].sort(
			(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
		);
		threads.push({
			id: root.id,
			path: root.path,
			line: root.line,
			diffHunk: root.diffHunk,
			comments: allInThread.map((c) => ({
				user: c.user,
				body: c.body,
				createdAt: c.createdAt,
			})),
		});
	}

	for (const c of issueComments) {
		threads.push({
			id: c.id,
			path: null,
			line: null,
			diffHunk: null,
			comments: [{ user: c.user, body: c.body, createdAt: c.createdAt }],
		});
	}

	return threads;
}

// ── AI recommendation generation ─────────────────────────────────────────────

const RECOMMENDATION_SYSTEM_PROMPT = `You are a senior code reviewer assistant. Given a PR review comment thread with optional diff context, suggest exactly 3 distinct approaches to address the feedback.

Each recommendation must have:
- A short label (max 60 chars) summarising the approach
- A detailed instruction the developer can follow

Output strict JSON — no markdown fences, no commentary:
[
  { "label": "Short label", "instruction": "Detailed instruction for the developer..." },
  { "label": "Short label", "instruction": "Detailed instruction for the developer..." },
  { "label": "Short label", "instruction": "Detailed instruction for the developer..." }
]

Guidelines:
- Range from conservative (minimal change) to thorough (refactor/redesign)
- Be concrete — reference file paths, function names, and specific changes
- Keep labels scannable; put detail in instructions`;

function buildThreadPrompt(thread: CommentThread, prTitle: string): string {
	const parts: string[] = [`PR: ${prTitle}`];
	if (thread.path) {
		parts.push(`File: ${thread.path}${thread.line ? `:${thread.line}` : ""}`);
	}
	if (thread.diffHunk) {
		parts.push(`Diff:\n${thread.diffHunk}`);
	}
	parts.push("");
	parts.push("Comments:");
	for (const c of thread.comments) {
		parts.push(`@${c.user}: ${c.body}`);
	}
	return parts.join("\n");
}

async function generateRecommendations(
	thread: CommentThread,
	prTitle: string,
	ctx: ExtensionCommandContext,
	signal: AbortSignal,
): Promise<Recommendation[]> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
	if (!auth.ok || !auth.apiKey) {
		return fallbackRecommendations();
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: buildThreadPrompt(thread, prTitle) }],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model!,
		{ systemPrompt: RECOMMENDATION_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);

	if (response.stopReason === "aborted") {
		return fallbackRecommendations();
	}

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");

	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed) && parsed.length >= 3) {
			return parsed.slice(0, 3).map((r: any) => ({
				label: String(r.label ?? "").slice(0, 80),
				instruction: String(r.instruction ?? ""),
			}));
		}
	} catch {
		// Fall through to fallback
	}

	return fallbackRecommendations();
}

function fallbackRecommendations(): Recommendation[] {
	return [
		{ label: "Apply the suggested change directly", instruction: "Apply the reviewer's suggestion as described in the comment." },
		{ label: "Investigate and fix with minimal change", instruction: "Investigate the concern raised and apply the smallest fix that addresses it." },
		{ label: "Refactor the surrounding code", instruction: "Refactor the related code to address the root cause of the reviewer's concern." },
	];
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pr-review", {
		description: "Walk through PR review comments for the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("pr-review requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected — needed to generate recommendations", "error");
				return;
			}

			// 1. Detect branch & PR
			ctx.ui.setStatus("pr-review", "Detecting PR…");
			const branch = await getCurrentBranch(pi);
			if (!branch) {
				ctx.ui.setStatus("pr-review", undefined);
				ctx.ui.notify("Could not detect current git branch", "error");
				return;
			}

			const pr = await getPRForBranch(pi, branch);
			if (!pr) {
				ctx.ui.setStatus("pr-review", undefined);
				ctx.ui.notify(`No open/draft PR found for branch: ${branch}`, "error");
				return;
			}

			// 2. Fetch comments
			ctx.ui.setStatus("pr-review", `Fetching comments for PR #${pr.number}…`);
			const [reviewComments, issueComments] = await Promise.all([
				getReviewComments(pi, pr.number),
				getIssueComments(pi, pr.number),
			]);
			ctx.ui.setStatus("pr-review", undefined);

			const threads = buildThreads(reviewComments, issueComments);
			if (threads.length === 0) {
				ctx.ui.notify(`PR #${pr.number} "${pr.title}" has no comments`, "info");
				return;
			}

			// 3. Generate recommendations for all threads (with loader UI)
			const threadsWithRecs = await ctx.ui.custom<ThreadWithRecs[] | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(
					tui,
					theme,
					`Generating recommendations for ${threads.length} thread(s) using ${ctx.model!.id}…`,
				);
				loader.onAbort = () => done(null);

				const doGenerate = async () => {
					const results: ThreadWithRecs[] = [];
					for (let i = 0; i < threads.length; i++) {
						ctx.ui.setStatus("pr-review", `Recommendations ${i + 1}/${threads.length}…`);
						const recs = await generateRecommendations(threads[i], pr.title, ctx, loader.signal);
						results.push({ thread: threads[i], recommendations: recs });
					}
					ctx.ui.setStatus("pr-review", undefined);
					return results;
				};

				doGenerate()
					.then(done)
					.catch((err) => {
						ctx.ui.setStatus("pr-review", undefined);
						done(null);
					});
				return loader;
			});

			if (!threadsWithRecs) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// 4. Q&A wizard — pick a recommendation or write custom
			const answers = await ctx.ui.custom<ThreadAnswer[]>((tui, theme, _kb, done) => {
				let currentThread = 0;
				let selectedOption = 0;
				let customMode = false;
				let customText = "";
				let cachedLines: string[] | undefined;
				const collected: ThreadAnswer[] = [];

				// Options: 3 recommendations + 1 skip + 1 custom
				function optionCount() {
					return threadsWithRecs[currentThread].recommendations.length + 2;
				}

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submitAnswer(instruction: string) {
					const twr = threadsWithRecs[currentThread];
					const firstComment = twr.thread.comments[0]?.body ?? "";
					collected.push({
						threadIndex: currentThread,
						path: twr.thread.path,
						line: twr.thread.line,
						summary: firstComment.slice(0, 200),
						instruction,
					});
					currentThread++;
					selectedOption = 0;
					customMode = false;
					customText = "";
					refresh();
					if (currentThread >= threadsWithRecs.length) {
						done(collected);
					}
				}

				function skipThread() {
					currentThread++;
					selectedOption = 0;
					customMode = false;
					customText = "";
					refresh();
					if (currentThread >= threadsWithRecs.length) {
						done(collected);
					}
				}

				function handleInput(data: string) {
					if (customMode) {
						if (matchesKey(data, Key.escape)) {
							customMode = false;
							refresh();
							return;
						}
						if (matchesKey(data, Key.enter)) {
							if (customText.trim()) {
								submitAnswer(customText.trim());
							}
							return;
						}
						if (matchesKey(data, Key.backspace)) {
							customText = customText.slice(0, -1);
							refresh();
							return;
						}
						if (data.length === 1 && data.charCodeAt(0) >= 32) {
							customText += data;
							refresh();
							return;
						}
						return;
					}

					if (matchesKey(data, Key.escape)) {
						done(collected);
						return;
					}
					if (matchesKey(data, Key.up)) {
						selectedOption = Math.max(0, selectedOption - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						selectedOption = Math.min(optionCount() - 1, selectedOption + 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						if (currentThread >= threadsWithRecs.length) {
							done(collected);
							return;
						}
						const recs = threadsWithRecs[currentThread].recommendations;
						if (selectedOption < recs.length) {
							// A recommendation
							submitAnswer(recs[selectedOption].instruction);
						} else if (selectedOption === recs.length) {
							// Skip
							skipThread();
						} else {
							// Custom
							customMode = true;
							customText = "";
							refresh();
						}
						return;
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					add(theme.fg("accent", "─".repeat(width)));

					// Header
					const draftBadge = pr.isDraft ? theme.fg("warning", " [DRAFT]") : "";
					add(
						` ${theme.fg("accent", theme.bold(`PR #${pr.number}`))}${draftBadge} ${theme.fg("text", pr.title)}`,
					);
					add(
						` ${theme.fg("muted", `Thread ${Math.min(currentThread + 1, threadsWithRecs.length)} of ${threadsWithRecs.length}`)}` +
							`  ${theme.fg("dim", `(${collected.length} addressed)`)}`,
					);
					add(theme.fg("accent", "─".repeat(width)));

					if (currentThread >= threadsWithRecs.length) {
						add(theme.fg("success", " ✓ All threads reviewed!"));
						add(theme.fg("dim", " Press Enter or Esc to finish."));
						add(theme.fg("accent", "─".repeat(width)));
						cachedLines = lines;
						return lines;
					}

					const twr = threadsWithRecs[currentThread];
					const thread = twr.thread;

					// File location
					if (thread.path) {
						const loc = thread.line ? `${thread.path}:${thread.line}` : thread.path;
						add(` ${theme.fg("accent", "📄 " + loc)}`);
					} else {
						add(` ${theme.fg("muted", "💬 General PR comment")}`);
					}

					// Diff hunk
					if (thread.diffHunk) {
						const hunkLines = thread.diffHunk.split("\n").slice(-4);
						lines.push("");
						for (const hl of hunkLines) {
							const color = hl.startsWith("+") ? "success" : hl.startsWith("-") ? "error" : "dim";
							add(`   ${theme.fg(color, hl)}`);
						}
					}

					lines.push("");

					// Comments
					for (const comment of thread.comments) {
						add(` ${theme.fg("accent", `@${comment.user}`)} ${theme.fg("dim", comment.createdAt.slice(0, 10))}`);
						for (const bodyLine of comment.body.split("\n")) {
							add(`   ${theme.fg("text", bodyLine)}`);
						}
						lines.push("");
					}

					add(theme.fg("accent", "─".repeat(width)));

					if (customMode) {
						add(` ${theme.fg("text", "Enter your instruction:")}`);
						add(` ${theme.fg("accent", "> ")}${customText}${theme.fg("dim", "█")}`);
						lines.push("");
						add(theme.fg("dim", " Enter to submit • Esc to go back"));
					} else {
						add(` ${theme.fg("text", "How should this be addressed?")}`);
						lines.push("");

						const recs = twr.recommendations;
						for (let i = 0; i < recs.length; i++) {
							const sel = i === selectedOption;
							const radio = sel ? theme.fg("accent", " ◉ ") : theme.fg("muted", " ○ ");
							const color = sel ? "accent" : "text";
							add(`${radio}${theme.fg(color, recs[i].label)}`);
							if (sel) {
								// Show full instruction for selected recommendation
								const wrapped = recs[i].instruction;
								for (const instrLine of wrapped.split("\n")) {
									add(`     ${theme.fg("dim", instrLine)}`);
								}
							}
						}

						lines.push("");

						// Skip option
						const skipIdx = recs.length;
						const skipSel = selectedOption === skipIdx;
						const skipRadio = skipSel ? theme.fg("accent", " ◉ ") : theme.fg("muted", " ○ ");
						add(`${skipRadio}${theme.fg(skipSel ? "warning" : "muted", "Skip this thread")}`);

						// Custom option
						const customIdx = recs.length + 1;
						const customSel = selectedOption === customIdx;
						const customRadio = customSel ? theme.fg("accent", " ◉ ") : theme.fg("muted", " ○ ");
						add(`${customRadio}${theme.fg(customSel ? "accent" : "muted", "Write custom instruction…")}`);

						lines.push("");
						add(theme.fg("dim", " ↑↓ navigate • Enter select • Esc finish early"));
					}

					add(theme.fg("accent", "─".repeat(width)));
					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			// 5. Build prompt from answers
			if (!answers || answers.length === 0) {
				ctx.ui.notify("No review actions collected", "info");
				return;
			}

			const promptLines: string[] = [
				`Address the following PR review feedback from PR #${pr.number} "${pr.title}":`,
				"",
			];

			for (const answer of answers) {
				const thread = threads[answer.threadIndex];
				const commentBodies = thread.comments.map((c) => `  @${c.user}: ${c.body}`).join("\n");
				const location = thread.path
					? `File: ${thread.path}${thread.line ? `:${thread.line}` : ""}`
					: "General comment";

				promptLines.push(`## ${location}`);
				promptLines.push("");
				promptLines.push(`Comments:`);
				promptLines.push(commentBodies);
				promptLines.push("");
				promptLines.push(`Instruction: ${answer.instruction}`);
				promptLines.push("");
				promptLines.push("---");
				promptLines.push("");
			}

			ctx.ui.setEditorText(promptLines.join("\n"));
			ctx.ui.notify(
				`${answers.length} thread(s) loaded into editor. Review and submit when ready.`,
				"info",
			);
		},
	});
}
