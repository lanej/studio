import assert from "node:assert/strict";
import { test } from "node:test";
import { shellHeredocs, prepareShellHeredoc } from "../shell-heredoc.ts";

await test("a quoted gh issue body keeps its Markdown source and subsequent shell commands", async () => {
  await prepareShellHeredoc();
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
  assert.deepEqual(shellHeredocs(command), {
    documents: [{ header, body, language: "markdown" }],
    following,
  });
});

await test("Markdown detection follows the stdin flag and the chosen delimiter", async () => {
  await prepareShellHeredoc();
  const header = "gh pr comment 42 -F -";
  const body = "## Review\n  - Nested item\nEOF\n";
  assert.deepEqual(
    shellHeredocs(
      `${header} <<-"NOTE"\n\t## Review\n\t  - Nested item\n\tEOF\n\tNOTE`,
    ),
    { documents: [{ header, body, language: "markdown" }], following: "" },
  );
  const edit = "gh issue edit 42 --body-file=-";
  assert.deepEqual(shellHeredocs(`${edit} <<BODY_END\nPlain body\nBODY_END`), {
    documents: [{ header: edit, body: "Plain body\n", language: "markdown" }],
    following: "",
  });
});

await test("only complete literal Markdown sent to gh on stdin qualifies", async () => {
  await prepareShellHeredoc();
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
    assert.equal(shellHeredocs(command), undefined, command);
  }
});

await test("explicit language markers use the syntax registry independent of their command", async () => {
  await prepareShellHeredoc();
  for (const [tag, language] of [
    ["SH", "bash"],
    ["Shell", "bash"],
    ["BaSh", "bash"],
    ["sQl", "sql"],
    ["MD", "markdown"],
    ["mArKdOwN", "markdown"],
    ["JS", "javascript"],
    ["TYPESCRIPT", "typescript"],
    ["PY", "python"],
    ["YML", "yaml"],
    ["FORTRAN", "fortran"],
    ["1C", "1c"],
  ] as const) {
    const header = `writer --template <<'${tag}'`;
    const body = "Value: $var and `expression`\n";
    assert.deepEqual(
      shellHeredocs(`${header}\n${body}${tag}`),
      {
        documents: [{ header, body, language }],
        following: "",
      },
      tag,
    );
  }
});

await test("an unquoted language tag displays authored templates and takes precedence over the gh body", async () => {
  await prepareShellHeredoc();
  const sql = "gh issue create --body-file - <<SQL";
  const body = "SELECT $id, `column` FROM records;\n";
  const markdown = "cat <<-Md";
  const mdBody = "Here is `$HOME`.\n";
  assert.deepEqual(
    shellHeredocs(`${sql}\n${body}SQL\n${markdown}\n\t${mdBody}\tMd`),
    {
      documents: [
        { header: sql, body, language: "sql" },
        { header: markdown, body: mdBody, language: "markdown" },
      ],
      following: "",
    },
  );
});

await test("output redirects before and after a marker remain visible with the tagged body", async () => {
  await prepareShellHeredoc();
  const body = "SELECT 1;\n";
  for (const header of [
    "cat > memo.txt <<'SQL'",
    "cat <<'SQL' > memo.txt",
    "cat <<'SQL' 2>&1 >> memo.txt",
    "cat <<'SQL' | psql",
  ]) {
    assert.deepEqual(shellHeredocs(`${header}\n${body}SQL\nprintf done`), {
      documents: [{ header, body, language: "sql" }],
      following: "printf done",
    });
  }
});

await test("raw documents, shell commands and final output boundaries survive mixed previews", async () => {
  await prepareShellHeredoc();
  const raw = "cat <<'EOF'\n# Still raw\nEOF";
  const first = "cat <<'MD'";
  const second = "cat <<'PY'";
  const source = [
    raw,
    first,
    "## Hello",
    "MD",
    raw,
    "echo between",
    second,
    "print(1)",
    "PY",
    "echo after",
  ].join("\n");
  assert.deepEqual(shellHeredocs(source), {
    documents: [
      { header: raw + "\n" + first, body: "## Hello\n", language: "markdown" },
      {
        header: raw + "\necho between\n" + second,
        body: "print(1)\n",
        language: "python",
      },
    ],
    following: "echo after",
  });
});

await test("partial markers, unknown tags and redirected stdin keep their raw source", async () => {
  await prepareShellHeredoc();
  for (const source of [
    "cat <<'EOF_SQL'\nSELECT 1;\nEOF_SQL",
    "cat <<'report.sql'\nSELECT 1;\nreport.sql",
    "cat <<'SQL'\nSELECT 1;",
    "cat <<'SQL' </dev/null\nSELECT 1;\nSQL",
    "cat 2<<SQL\nSELECT 1;\nSQL",
    "cat <<SQL\nSELECT 1;\nSQL ",
    'echo "cat <<SQL"',
  ])
    assert.equal(shellHeredocs(source), undefined, source);
});
