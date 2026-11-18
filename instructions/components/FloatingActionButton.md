COMPONENT: FloatingActionButton

A round button pinned to a corner or an edge of the Card it is in. It must be written directly inside a Card, and that Card needs room for it, such as minHeight="160px".

Written as `<FloatingActionButton icon="FiPlus" />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| icon | FiCheck, FiX, FiAlertTriangle, FiInfo, FiStar, FiUser, FiUsers, FiClock, FiCalendar, FiFolder, FiFile, FiHome, FiSettings, FiTrendingUp, FiTrendingDown, FiDollarSign, FiMail, FiPhone, FiMapPin, FiHeart, FiPlus, FiEdit, FiMessageSquare, FiArrowUp | Required. The drawing on the button. |
| send | text | The message that is sent in the chat when it is clicked. Without it a click does nothing. |
| position | top-left, top, top-right, left, right, bottom-left, bottom, bottom-right | Which corner or edge of the Card it is pinned to. |
| color | primary (the theme's main colour), secondary (its second colour), tertiary (its third colour), success (green), warning (amber), error (red) | The colour of the button. The default is primary. |
| size | xs, sm, md, lg, xl, from smallest to largest | How large the button is. |
| badge | short text or a number | Shown in a small circle on the corner of the button. |
| badgeColor | primary (the theme's main colour), secondary (its second colour), tertiary (its third colour), success (green), warning (amber), error (red) | The colour of that small circle. |
| draggable | no value | The user can drag the button to another place on the Card. |

```component
<Card minHeight="160px">
  <Typography weight="bold">Notes</Typography>
  <FloatingActionButton icon="FiPlus" position="bottom-right" send="Add a note" />
</Card>
```
