COMPONENT: Button

A button the user can click. A click sends a message in the chat as if the user had typed it.

Written as `<Button>label</Button>`. The label goes between the tags.

| Attribute | Values | What it does on screen |
|---|---|---|
| send | text | The message that is sent when the button is clicked. Without it, the label itself is sent. |
| color | primary (the theme's main colour), secondary (its second colour), tertiary (its third colour), success (green), warning (amber), error (red) | The colour of the button. |
| variant | solid, ghost, border-shadow | solid is filled with its colour. ghost has no fill, only the label. border-shadow is a raised outline. |
| size | xs, sm, md, lg, xl, from smallest to largest | How large the button is. The default is sm. |
| icon | FiCheck, FiX, FiAlertTriangle, FiInfo, FiStar, FiUser, FiUsers, FiClock, FiCalendar, FiFolder, FiFile, FiHome, FiSettings, FiTrendingUp, FiTrendingDown, FiDollarSign, FiMail, FiPhone, FiMapPin, FiHeart | A small drawing shown before the label. With an icon the label may be left out. |
| disabled | no value | The button is greyed and cannot be clicked. |
| width | a CSS length such as 100% or 240px | How wide the button is. Without it the button is as wide as its label. |
| align | start, center, end | Where the label sits inside a button that is wider than it. |
| flat | no value | No border or shadow appears when the mouse is over it. |

```component
<Button color="primary" icon="FiCalendar" send="Show me next week">Next week</Button>
```
