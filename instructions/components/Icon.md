COMPONENT: Icon

A small line drawing.

Written as `<Icon name="FiCheck" />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| name | FiCheck, FiX, FiAlertTriangle, FiInfo, FiStar, FiUser, FiUsers, FiClock, FiCalendar, FiFolder, FiFile, FiHome, FiSettings, FiTrendingUp, FiTrendingDown, FiDollarSign, FiMail, FiPhone, FiMapPin, FiHeart | Required. Which drawing is shown. |
| color | primary (the theme's main colour), secondary (its second colour), tertiary (its third colour), success (green), warning (amber), error (red) | The colour of the drawing. |
| size | xs, sm, md, lg, xl, from smallest to largest | How large it is. The default is sm. |

```component
<Icon name="FiAlertTriangle" color="warning" size="md" />
```
