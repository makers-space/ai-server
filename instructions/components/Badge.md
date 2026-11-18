COMPONENT: Badge

A small filled label with a word or two, slightly rounded at the corners. The text is always the theme's contrast colour and stays on one line.

Written as `<Badge>text</Badge>`.

| Attribute | Values | What it does on screen |
|---|---|---|
| color | default, primary, secondary, tertiary (the theme's three colours), success, warning, error (usually green, amber and red, but each theme sets them) | Fill colour. default is a neutral tint. |
| size | xxs, xs, sm, md, lg, xl | Text height 10, 11, 13, 14, 15 or 16px on a desktop-width window. Default sm. |

```component
<Badge color="warning">Pending</Badge>
```
