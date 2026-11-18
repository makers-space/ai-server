COMPONENT: Typography

A piece of text with its own size, weight and colour.

Written as `<Typography>text</Typography>`. The text goes between the tags.

| Attribute | Values | What it does on screen |
|---|---|---|
| size | xxs, xs, sm, md, lg, xl, 2xl, 3xl, 4xl | How large the text is, from smallest to largest. The default is xs, the size of ordinary writing in the chat. 2xl and above are for large figures and titles. |
| weight | normal, medium, semibold, bold | How heavy the letters are. |
| color | default, muted, primary (the theme's main colour), secondary (its second colour), tertiary (its third colour), success (green), warning (amber), error (red) | The colour of the text. default is the normal text colour. muted is greyed. |
| font | primary, secondary, monospace | The typeface. primary is the theme's main one, secondary its second one, monospace has letters of equal width. |
| as | h2, h3, h4, p, span | What kind of text it is. h2, h3 and h4 are headings, p is a paragraph on its own line, span sits within a line. |
| href | an https or mailto address | Makes the text a link that opens in a new tab. |
| truncate | no value | Keeps the text on one line and ends it with an ellipsis when it is too long. |

```component
<Typography size="2xl" weight="bold" color="primary">42%</Typography>
```
