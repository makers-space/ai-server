COMPONENT: Button

A button. Clicking it sends a message in the chat as if the user had typed it. Clicks are ignored while a reply is still being written.

Written as `<Button>label</Button>`. In a block layout a button is as wide as the box it is in; inside a flex row or a ButtonGroup it is as wide as its label.

| Attribute | Values | What it does on screen |
|---|---|---|
| send | text | The message sent on a click. Without it the label is sent. A button with neither a label nor send does nothing. |
| color | primary, secondary, tertiary (the theme's three colours), success, warning, error (usually green, amber and red, but each theme sets them) | The button's colour. Default primary. |
| variant | solid, ghost, border-shadow | Without it: panel-coloured fill with the label and a thin border in the colour; it fills with the colour on hover. solid: filled with the colour, darker on hover. ghost: no fill or border, just the coloured label, tinted on hover. border-shadow: no border, a small shadow, fills with the colour on hover. |
| size | xxs, xs, sm, md, lg, xl | Height 26, 32, 36, 40, 44 or 50px on a desktop-width window, with text to match. Default sm. |
| icon | an icon name (see Icon) | A small drawing before the label, in the label's colour. With an icon the label may be left out, but then give send. |
| disabled | no value | Faded and cannot be clicked. |
| width | a CSS length with its unit, such as 100% or 240px | How wide the button is. |
| align | start, center, end | Where the label sits in a button wider than it. Default center. |
| flat | no value | Removes the border, shadow and lift, at rest and on hover. |

```component
<Button variant="solid" color="primary" icon="FiCalendar" send="Show me next week">Next week</Button>
```
