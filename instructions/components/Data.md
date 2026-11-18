COMPONENT: Data

A table of records.

Written as `<Data> ... </Data>` with one Row tag for each record, or as `<Data src="https://..." />` to show a file.

| Attribute | Values | What it does on screen |
|---|---|---|
| variant | table, cards, list | How the records are laid out. table: rows and columns with a header (the default). cards: one small panel for each record. list: one line for each record. |
| src | the https address of a CSV file or a JSON list | Loads the records from that file instead of from Row tags. |

Tags that go inside Data:

| Tag | Attributes | What it does on screen |
|---|---|---|
| `<Row />` | any names you choose, such as task="Design" status="Open" | One record. Every attribute is one column, and its value is what that cell shows. Use the same names on every Row. |
| `<Column />` | key, label, as, colors | Optional, written before the Rows. Changes how one column is shown. key: the Row attribute it applies to. label: the text in the column's header. as: Badge shows each value in a pill, ProgressBar shows a number from 0 to 100 as a bar with its percentage, Typography shows plain text. colors: for Badge, which value gets which colour, written as pairs such as "Open:success, Late:error". |

```component
<Data>
  <Column key="task" label="Task" />
  <Column key="status" label="Status" as="Badge" colors="Open:success, Late:error" />
  <Column key="done" label="Progress" as="ProgressBar" />
  <Row task="Design" status="Open" done="40" />
  <Row task="Build" status="Late" done="10" />
</Data>
```
That draws a table with three columns: the task as text, the status as a green or red pill, and the progress as a bar.
