import assert from "node:assert/strict";
import { test } from "node:test";
import {
  markdownHeredoc,
  prepareMarkdownHeredoc,
} from "../markdown-heredoc.ts";

await test("a quoted gh issue body keeps its Markdown source and subsequent shell commands", async () => {
  await prepareMarkdownHeredoc();
  const header =
    "gh issue create --repo example/cli --title 'Support per-user CLI credentials' --body-file -";
  const body = [
    "",
    "## Problem",
    "",
    "Keep **credentials** scoped to `cli sign-in`.",
    "",
    "- Verify expiration",
    "  - Include the literal `EOF` in the transcript",
    "",
    "```sh",
    'printf "%s" "$USER"',
    "```",
    "",
  ].join("\n");
  const following = "printf 'issue created\\n'";
  const command = `${header} <<'EOF'\n${body}EOF\n${following}`;
  assert.deepEqual(markdownHeredoc(command), { header, body, following });
});

await test("Markdown detection follows the stdin flag and the chosen delimiter", async () => {
  await prepareMarkdownHeredoc();
  const header = "gh pr comment 42 -F -";
  const body = "## Review\n  - Nested item\nEOF\n";
  assert.deepEqual(
    markdownHeredoc(
      `${header} <<-"NOTE"\n\t## Review\n\t  - Nested item\n\tEOF\n\tNOTE`,
    ),
    { header, body, following: "" },
  );
  const edit = "gh issue edit 42 --body-file=-";
  assert.deepEqual(markdownHeredoc(`${edit} <<TEXT\nPlain body\nTEXT`), {
    header: edit,
    body: "Plain body\n",
    following: "",
  });
});

await test("only complete literal Markdown sent to gh on stdin qualifies", async () => {
  await prepareMarkdownHeredoc();
  const header = "gh issue create --body-file -";
  for (const command of [
    "bash <<'EOF'\n# Run diagnostics\nprintf hello\nEOF",
    "gh api issues --input - <<'EOF'\n{}\nEOF",
    "gh issue create --title '--body-file -' <<'EOF'\n## Note\nEOF",
    "gh issue create --body-file report.md <<'EOF'\n## Note\nEOF",
    `${header} 3<<'EOF'\n## Note\nEOF`,
    `${header} <<'EOF' </dev/null\n## Note\nEOF`,
    `${header} <<EOF\nHello $USER\nEOF`,
    `${header} <<EOF\nHello $(whoami)\nEOF`,
    `${header} <<'EOF'\n## Still streaming\n`,
    `${header} <<'EOF'\n## Trailing space on delimiter\nEOF `,
  ]) {
    assert.equal(markdownHeredoc(command), undefined, command);
  }
});
