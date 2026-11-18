COMPONENT: Editor

A panel that shows text which cannot be edited: formatted writing, a page, or code with line numbers and colours.

Written as `<Editor mode="markdown">text</Editor>` with the text between the tags, or as `<Editor src="https://..." />` to show a text, Markdown or code file.

| Attribute | Values | What it does on screen |
|---|---|---|
| mode | markdown, document, code | markdown: the text is shown formatted, with headings, lists and links. document: the text is shown as a page, like a printed sheet. code: the text is shown as code with line numbers and colours. |
| language | js, jsx, ts, tsx, html, css, json, md, txt, bash, sh, python, py, sql, yml, yaml, ruby, go, rust, c, cpp, java | For code mode: the language, which decides the colours. |
| src | the https address of a text, Markdown or code file | Loads the text from that file instead of from between the tags. |

```component
<Editor mode="document">
# Meeting notes

- Budget approved
- Launch moved to March
</Editor>
```
