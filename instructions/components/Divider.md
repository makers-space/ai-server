COMPONENT: Divider

A thin horizontal line across the width of the box it is in.

Written as `<Divider />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| label | text | Shown in the middle of the line, which breaks around it. |
| variant | solid, dashed, dotted | The style of the line. solid is the default. |
| color | primary (the theme's main colour), secondary (its second colour), tertiary (its third colour), success (green), warning (amber), error (red) | The colour of the line. |
| size | xs, sm, md, lg, xl, from smallest to largest | The thickness of the line. |

```component
<Divider label="Details" variant="dashed" />
```
