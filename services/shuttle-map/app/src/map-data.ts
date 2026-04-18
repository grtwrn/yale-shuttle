// ── Types ──────────────────────────────────────────────────────────────────

export interface Station {
  id: string;
  label: string;
  x: number;
  y: number;
  labelSide: "l" | "r" | "t" | "b";
  stopIds: number[];
  isHome?: boolean;
  /** Direction indicator shown inside the dot: "N", "S", "E", "W" */
  dir?: string;
}

export interface RouteSegment {
  points: [number, number][];
}

export interface Route {
  id: string;
  label: string;
  color: string;
  segments: RouteSegment[];
  /** Direction arrows: [x, y, angleDeg] */
  arrows: [number, number, number][];
  /** Dashed stroke for directional distinction */
  dashed?: boolean;
}

export interface BusData {
  bus_id: number;
  bus_name: string;
  route_id: number;
  lat: number;
  lon: number;
  heading: number;
  last_stop_id: number;
  stationary?: boolean;
  at_stop_id?: number;
  at_stop_since?: string;
}

// ── Stations ───────────────────────────────────────────────────────────────

export const stations: Station[] = [
  // Red north
  { id: "winchester",    label: "Winchester",        x: 140, y: 80,  labelSide: "l", stopIds: [11] },
  { id: "division",      label: "Division",          x: 400, y: 80,  labelSide: "t", stopIds: [48, 49] },
  { id: "winch_sachem",  label: "Winch / Sachem",    x: 140, y: 200, labelSide: "l", stopIds: [147] },

  // Blue north — Whitney corridor (north→south, x=640)
  { id: "huntington",    label: "Huntington",        x: 510, y: 80,  labelSide: "t", stopIds: [105, 69] },
  { id: "whitney_hunt",  label: "Whitney / Hunt",    x: 640, y: 80,  labelSide: "r", stopIds: [139] },
  { id: "whitney_highland", label: "Whitney / Highland", x: 640, y: 130, labelSide: "r", stopIds: [136] },
  { id: "whitney_cold",  label: "Whitney / Cold Spring", x: 640, y: 170, labelSide: "r", stopIds: [130] },
  { id: "canner",        label: "Canner",            x: 640, y: 200, labelSide: "r", stopIds: [129, 29] },
  { id: "whitney_linden",label: "Whitney / Linden",   x: 640, y: 250, labelSide: "r", stopIds: [140] },
  { id: "cottage",       label: "Cottage",            x: 640, y: 300, labelSide: "r", stopIds: [132, 133] },
  { id: "whitney_edwards",label:"Whitney / Edwards",  x: 640, y: 335, labelSide: "r", stopIds: [134, 135] },
  { id: "whitney_humphrey",label:"Whitney / Humphrey",x: 640, y: 360, labelSide: "r", stopIds: [137, 138, 172] },
  { id: "peabody",       label: "Peabody",           x: 640, y: 395, labelSide: "r", stopIds: [97] },
  { id: "whitney_trumbull",label:"Whitney / Trumbull",x: 620, y: 440, labelSide: "r", stopIds: [141] },
  { id: "whitney_audubon",label:"Whitney / Audubon",  x: 600, y: 462, labelSide: "r", stopIds: [128] },

  // Orange St corridor (north→south, x=770)
  { id: "orange_willow", label: "Orange / Willow",   x: 770, y: 170, labelSide: "r", stopIds: [94, 95] },
  { id: "orange_canner", label: "Orange / Canner",   x: 770, y: 200, labelSide: "r", stopIds: [82] },
  { id: "orange_avon",   label: "Orange / Avon",     x: 770, y: 230, labelSide: "r", stopIds: [77] },
  { id: "orange_cottage",label: "Orange / Cottage",  x: 770, y: 260, labelSide: "r", stopIds: [83] },
  { id: "orange_edwards",label: "Orange / Edwards",  x: 770, y: 290, labelSide: "r", stopIds: [50, 84, 85] },
  { id: "orange_lawrence",label:"Orange / Lawrence", x: 770, y: 320, labelSide: "r", stopIds: [89] },
  { id: "orange_bishop", label: "Orange / Bishop",   x: 770, y: 350, labelSide: "r", stopIds: [78, 79] },
  { id: "orange_humphrey",label:"Orange / Humphrey", x: 770, y: 380, labelSide: "r", stopIds: [87, 88] },
  { id: "orange_pearl",  label: "Orange / Pearl",    x: 770, y: 410, labelSide: "r", stopIds: [91, 92] },
  { id: "orange_bradley",label: "Orange / Bradley",  x: 770, y: 440, labelSide: "r", stopIds: [80, 81] },
  { id: "orange_trumbull",label:"Orange / Trumbull", x: 770, y: 470, labelSide: "r", stopIds: [93] },
  { id: "orange_grove",  label: "Orange / Grove",    x: 770, y: 500, labelSide: "r", stopIds: [86] },
  { id: "audubon",       label: "Audubon / Orange",  x: 770, y: 530, labelSide: "r", stopIds: [19] },

  // Foster Ave cluster (east of Orange St, between Willow and Orange/Edwards)
  { id: "foster_avon",   label: "Foster / Avon",     x: 830, y: 230, labelSide: "r", stopIds: [55] },
  { id: "foster_cottage",label: "Foster / Cottage",  x: 830, y: 260, labelSide: "r", stopIds: [56] },
  { id: "foster_lawrence",label:"Foster / Lawrence", x: 830, y: 290, labelSide: "r", stopIds: [58] },
  { id: "foster_edwards",label: "Foster / Edwards",  x: 830, y: 320, labelSide: "r", stopIds: [57] },

  // Willow corridor (east of Whitney, east-west street between Whitney and Orange)
  { id: "willow_foster", label: "Willow / Foster",   x: 710, y: 170, labelSide: "t", stopIds: [142] },
  { id: "willow_livingston", label:"Willow / Livingston", x: 710, y: 155, labelSide: "t", stopIds: [143] },
  { id: "willow_whitney",label: "Willow / Whitney",  x: 680, y: 150, labelSide: "t", stopIds: [144] },

  // Canner corridor (east of Whitney, between canner and orange_canner)
  { id: "canner_livingston", label:"Canner / Livingston", x: 705, y: 200, labelSide: "t", stopIds: [28] },

  // Blue Night unique stops
  { id: "payne_whitney", label: "Payne Whitney",     x: 320, y: 530, labelSide: "l", stopIds: [96] },
  { id: "wall_york",     label: "Wall / York",       x: 280, y: 470, labelSide: "l", stopIds: [67] },

  // Orange Night (extra stops not on day route)
  { id: "church_grove",  label: "Church / Grove",    x: 490, y: 470, labelSide: "r", stopIds: [36] },
  { id: "som",           label: "SOM",               x: 580, y: 340, labelSide: "r", stopIds: [114] },
  { id: "church_south",  label: "Church St South",   x: 400, y: 1020, labelSide: "l", stopIds: [1] },

  // Orange East (unique stops — east side of campus)
  { id: "elm_orange",    label: "Elm / Orange",      x: 700, y: 600, labelSide: "r", stopIds: [157] },
  { id: "eagle_nash",    label: "Eagle / Nash",      x: 830, y: 470, labelSide: "r", stopIds: [165, 166] },
  { id: "nicoll",        label: "Nicoll / Edwards",  x: 830, y: 560, labelSide: "r", stopIds: [167] },
  { id: "olive_chapel",  label: "Olive / Chapel",    x: 700, y: 700, labelSide: "r", stopIds: [75] },
  { id: "olive_lyon",    label: "Olive / Lyon",      x: 700, y: 660, labelSide: "r", stopIds: [158] },
  { id: "olive_greene",  label: "Olive / Greene",    x: 700, y: 620, labelSide: "r", stopIds: [159] },
  { id: "union_fair",    label: "Union / Fair",      x: 580, y: 800, labelSide: "r", stopIds: [160, 168] },

  // Canal/Munson (shared by Red NB, Blue West, Brown)
  { id: "canal_munson",  label: "Canal / Munson",    x: 110, y: 140, labelSide: "l", stopIds: [27] },

  // Brown Connector
  { id: "science_park",  label: "Science Park",      x: 240, y: 30,  labelSide: "r", stopIds: [145] },

  // Pink — VA Hospital / Med School (west-southwest of campus)
  { id: "york_cedar",    label: "York / Cedar",      x: 280, y: 730, labelSide: "l", stopIds: [149] },
  { id: "congress_howard", label: "Congress / Howard", x: 220, y: 800, labelSide: "l", stopIds: [44] },
  { id: "davenport_howard",label:"Davenport / Howard", x: 180, y: 830, labelSide: "l", stopIds: [46] },
  { id: "front_rt1_n",   label: "Front / Rt 1 (N)",  x: 140, y: 870, labelSide: "l", stopIds: [59] },
  { id: "front_rt1_s",   label: "Front / Rt 1 (S)",  x: 130, y: 880, labelSide: "l", stopIds: [60] },
  { id: "quigley_in",    label: "Quigley (In)",      x: 100, y: 890, labelSide: "l", stopIds: [109] },
  { id: "quigley_out",   label: "Quigley (Out)",     x: 100, y: 905, labelSide: "l", stopIds: [110] },
  { id: "va_entrance_in",label: "VA Entrance (In)",  x: 70,  y: 915, labelSide: "l", stopIds: [123] },
  { id: "va_hospital",   label: "VA Hospital",       x: 40,  y: 925, labelSide: "l", stopIds: [125] },
  { id: "va_entrance_out",label:"VA Entrance (Out)", x: 70,  y: 935, labelSide: "l", stopIds: [124] },

  // Purple — West Campus / West Haven
  { id: "union_south",   label: "Union (S)",         x: 330, y: 960, labelSide: "l", stopIds: [122] },
  { id: "west_haven",    label: "West Haven Stn",    x: 140, y: 1060, labelSide: "l", stopIds: [127] },
  // West Campus buildings (served by Green and Purple)
  { id: "bldg_400",      label: "Bldg 400",          x: 50,  y: 960,  labelSide: "l", stopIds: [22] },
  { id: "bldg_600",      label: "Bldg 600",          x: 50,  y: 985,  labelSide: "l", stopIds: [23] },
  { id: "bldg_750",      label: "Bldg 750",          x: 50,  y: 1010, labelSide: "l", stopIds: [24] },
  { id: "bldg_800",      label: "Bldg 800",          x: 50,  y: 1035, labelSide: "l", stopIds: [25] },
  { id: "bldg_900",      label: "Bldg 900",          x: 50,  y: 1060, labelSide: "l", stopIds: [26] },

  // Gold — west side loop
  { id: "howard_park",   label: "Howard / Park",     x: 180, y: 720, labelSide: "l", stopIds: [153] },
  { id: "chapel_dwight", label: "Chapel / Dwight",   x: 180, y: 680, labelSide: "l", stopIds: [154] },
  { id: "howe_edgewood", label: "Howe / Edgewood",   x: 200, y: 600, labelSide: "l", stopIds: [155] },
  { id: "elm_lynwood",   label: "Elm / Lynwood",     x: 250, y: 550, labelSide: "l", stopIds: [156] },

  // Blue West — northwest corridor (Canal → Mansfield/Division → Pauli Murray → Phelps)
  { id: "mansfield_div", label: "Mansfield / Div",   x: 220, y: 170, labelSide: "l", stopIds: [163] },
  { id: "ashmun_lock",   label: "Ashmun / Lock",     x: 160, y: 300, labelSide: "l", stopIds: [162] },
  { id: "york_elm",      label: "York / Elm",        x: 290, y: 550, labelSide: "l", stopIds: [161] },

  // Blue / Grocery Hamden / Orange East — misc street corners
  { id: "broadway_york", label: "Broadway / York",   x: 250, y: 470, labelSide: "l", stopIds: [21] },
  { id: "elm_college",   label: "Elm / College",     x: 330, y: 530, labelSide: "l", stopIds: [54] },
  { id: "york_chapel",   label: "York / Chapel",     x: 300, y: 640, labelSide: "l", stopIds: [150] },
  { id: "stop_shop",     label: "Stop & Shop",       x: 200, y: 480, labelSide: "l", stopIds: [116] },
  { id: "chapel_state",  label: "Chapel / State",    x: 540, y: 900, labelSide: "r", stopIds: [32] },

  // Red route — extra east/south stops
  { id: "wall_church",   label: "Wall / Church",     x: 520, y: 470, labelSide: "t", stopIds: [126] },
  { id: "gilbert_cedar", label: "Gilbert / Cedar",   x: 440, y: 800, labelSide: "l", stopIds: [117] },

  // Blue Night misc
  { id: "george_81",     label: "81 George",         x: 440, y: 680, labelSide: "r", stopIds: [12] },
  { id: "church_george", label: "Church / George",   x: 480, y: 680, labelSide: "r", stopIds: [35] },

  // Grocery
  { id: "trader_joes",   label: "Trader Joe's",      x: 700, y: 530, labelSide: "r", stopIds: [119] },
  { id: "aldi_walmart",  label: "Aldi / Walmart",    x: 830, y: 300, labelSide: "r", stopIds: [170] },
  { id: "shop_rite",     label: "Shop Rite",         x: 830, y: 370, labelSide: "r", stopIds: [169] },

  // Prospect spine (north→south, x=400)
  { id: "winch_division", label: "Winch / Division", x: 260, y: 80,  labelSide: "t", stopIds: [146] },
  { id: "scl",            label: "SCL",              x: 355, y: 105, labelSide: "l", stopIds: [113] },
  { id: "pr_hillside",    label: "Prospect / Hillside", x: 400, y: 120, labelSide: "r", stopIds: [104] },
  { id: "pr_highland",    label: "Prospect / Highland", x: 400, y: 155, labelSide: "r", stopIds: [102] },
  { id: "pr_divinity",    label: "Divinity / 409 Prospect", x: 400, y: 185, labelSide: "r", stopIds: [47] },
  { id: "pr_edwards",     label: "Prospect / Edwards", x: 400, y: 215, labelSide: "r", stopIds: [101] },
  { id: "pr_canner",     label: "Prospect / Canner", x: 400, y: 240, labelSide: "r", stopIds: [100], isHome: true },
  { id: "pr_chemistry",   label: "225 Prospect / Chem", x: 400, y: 270, labelSide: "r", stopIds: [34] },
  { id: "pr_sachem",     label: "Prospect / Sachem",  x: 400, y: 300, labelSide: "r", stopIds: [106, 107] },
  { id: "pr_130",        label: "130 Prospect St",    x: 400, y: 360, labelSide: "r", stopIds: [3, 4] },
  { id: "becton",        label: "Becton",            x: 400, y: 420, labelSide: "r", stopIds: [20] },
  { id: "pr_trumbull",    label: "Prospect / Trumbull",x: 400, y: 445, labelSide: "r", stopIds: [108] },
  { id: "trumbull_hillhouse", label:"Trumbull / Hillhouse", x: 460, y: 455, labelSide: "r", stopIds: [120] },

  // Central
  { id: "college_wall", label: "College / Wall",     x: 400, y: 470, labelSide: "l", stopIds: [41, 42] },
  { id: "grove",         label: "Grove / Temple",    x: 580, y: 470, labelSide: "r", stopIds: [63, 64, 118] },
  { id: "phelps",        label: "Phelps Gate",       x: 400, y: 530, labelSide: "l", stopIds: [98] },

  // Blue West
  { id: "pauli_murray",  label: "Pauli Murray",      x: 110, y: 360, labelSide: "l", stopIds: [164] },
  { id: "howard",        label: "Howard",            x: 110, y: 720, labelSide: "l", stopIds: [] },

  // South trunk
  { id: "crown",         label: "Crown",             x: 400, y: 600, labelSide: "l", stopIds: [38] },
  { id: "george",        label: "George",            x: 400, y: 660, labelSide: "l", stopIds: [39, 9] },
  { id: "leph",          label: "LEPH",              x: 400, y: 730, labelSide: "l", stopIds: [72] },

  // York leg
  { id: "york_129",      label: "129 York",          x: 330, y: 800, labelSide: "l", stopIds: [2] },
  { id: "york_180",      label: "180 York",          x: 330, y: 860, labelSide: "l", stopIds: [5] },
  { id: "elm_york",      label: "Elm / York",        x: 330, y: 920, labelSide: "l", stopIds: [52, 53] },

  // Cedar / south
  { id: "cedar_333",     label: "333 Cedar",         x: 490, y: 800, labelSide: "r", stopIds: [10, 43] },
  { id: "amistad",       label: "Amistad",           x: 490, y: 860, labelSide: "r", stopIds: [13, 14] },
  { id: "chapel",        label: "Chapel",            x: 590, y: 860, labelSide: "r", stopIds: [30, 31] },
  { id: "union",         label: "Union Station",     x: 400, y: 960, labelSide: "r", stopIds: [121] },
  { id: "state_st",      label: "State St",          x: 490, y: 960, labelSide: "r", stopIds: [115] },
  { id: "court_olive",   label: "Court / Olive",     x: 490, y: 1020, labelSide: "r", stopIds: [45] },
];

// ── Routes ─────────────────────────────────────────────────────────────────

export const routes: Route[] = [
  // RED — northbound (left offset, solid)
  // Court/Olive → Chapel → up east → College/Wall → up Prospect → Winch/Sachem → Canal → Winchester → Division
  {
    id: "red_nb_south", label: "Red NB", color: "#C62828",
    segments: [
      { points: [[484, 1020], [584, 920]] },       // Court/Olive → diag up to Chapel area
      { points: [[584, 920], [584, 860]] },         // up to Chapel
      { points: [[584, 860], [484, 760]] },         // Chapel → diag up
      { points: [[484, 760], [484, 530]] },         // up east side to Phelps height
      { points: [[484, 530], [394, 470]] },         // diag into College/Wall
      { points: [[394, 470], [394, 200]] },         // up Prospect (left)
      { points: [[394, 200], [140, 194]] },         // across to Winch/Sachem
    ],
    arrows: [],
  },
  {
    id: "red_nb", label: "Red NB", color: "#C62828",
    segments: [
      { points: [[140, 194], [110, 164]] },        // Winch/Sachem → diag to Canal
      { points: [[110, 164], [110, 140]] },         // up to Canal/Munson
      { points: [[110, 140], [140, 110]] },         // Canal → diag to Winchester
      { points: [[140, 110], [140, 74]] },           // up to Winchester
      { points: [[140, 74], [400, 74]] },            // across to Division (top)
    ],
    arrows: [],
  },

  // RED — southbound (dashed). Shares x=394 with the NB line on the Prospect
  // and Wall→LEPH columns so the two directions render colinear there.
  // Division → down Prospect → south trunk → LEPH → Cedar → Amistad → Union.
  {
    id: "red_sb", label: "Red SB", color: "#C62828", dashed: true,
    segments: [
      { points: [[394, 86], [394, 730]] },           // Division → Wall → LEPH
      { points: [[394, 730], [496, 800]] },          // LEPH → Cedar (diag)
      { points: [[496, 800], [496, 860]] },          // Cedar → Amistad
      { points: [[496, 860], [400, 960]] },          // Amistad → Union (diag)
    ],
    arrows: [],
  },

  // RED — loop closure: Union → State St → Court/Olive (heading back to NB start)
  {
    id: "red_loop", label: "Red NB", color: "#C62828",
    segments: [
      { points: [[400, 960], [496, 960]] },         // Union → State St
      { points: [[496, 960], [496, 1020]] },        // State St → Court/Olive
    ],
    arrows: [],
  },

  // BLUE DAY — NB (solid): Elm/York → up York → east to Wall → UP Prospect
  // through Sachem to Division. Sits at x=402, immediately adjacent to the
  // Red column at x=394.
  {
    id: "blue_day_nb", label: "Blue", color: "#1565C0",
    segments: [
      { points: [[340, 920], [340, 470]] },   // up York
      { points: [[340, 470], [402, 470]] },   // east to Wall
      { points: [[402, 470], [402, 74]] },    // up Prospect (Wall → Sachem → Division)
    ],
    arrows: [],
  },
  // BLUE DAY — SB (dashed): Division → across top → down Whitney → Grove →
  // Wall → LEPH → east to Cedar → west to York → down to Elm/York.
  // Shares x=402 with Blue Day NB so the two directions render colinear on
  // the Prospect and Wall columns, adjacent to the Red lines at x=394.
  {
    id: "blue_day_sb", label: "Blue", color: "#1565C0", dashed: true,
    segments: [
      { points: [[402, 74], [634, 74]] },     // Division → across top to Whitney
      { points: [[634, 74], [634, 380]] },    // down Whitney
      { points: [[634, 380], [574, 470]] },   // diag to Grove
      { points: [[574, 470], [402, 470]] },   // Grove → Wall
      { points: [[402, 470], [402, 730]] },   // down Wall → LEPH
      { points: [[402, 730], [504, 800]] },   // LEPH → Cedar (parallel to Red, 8px east)
      { points: [[504, 800], [340, 800]] },   // Cedar → York (west)
      { points: [[340, 800], [340, 920]] },   // down to Elm/York
    ],
    arrows: [],
  },

  // BLUE NIGHT — Cedar → York → Wall/York → Payne Whitney → Wall → Sachem → Peabody → Grove → south → Union → Cedar
  // BLUE NIGHT — NB (solid). Prospect column pushed to x=410 so it sits
  // outside both the Red stack (x=394) and the Blue Day stack (x=402).
  {
    id: "blue_night_nb", label: "Blue Night", color: "#1E88E5",
    segments: [
      { points: [[490, 800], [330, 800]] },         // Cedar → 129 York
      { points: [[330, 800], [280, 470]] },          // York → Wall/York (diag)
      { points: [[280, 470], [320, 530]] },          // Wall/York → Payne Whitney (diag)
      { points: [[320, 530], [410, 470]] },          // Payne Whitney → College/Wall (diag)
      { points: [[410, 470], [410, 300]] },          // Wall → Prospect/Sachem
      { points: [[410, 300], [640, 300]] },          // across to Cottage/Peabody area
    ],
    arrows: [],
  },
  {
    id: "blue_night_sb", label: "Blue Night", color: "#1E88E5", dashed: true,
    segments: [
      { points: [[640, 300], [580, 470]] },         // Peabody area → Grove (diag)
      { points: [[580, 470], [410, 470]] },          // Grove → Wall
      { points: [[410, 470], [410, 730]] },          // Wall → LEPH
      { points: [[410, 730], [410, 960]] },          // LEPH → Union
      { points: [[410, 960], [410, 1020]] },         // Union → Church St South
      { points: [[410, 1020], [490, 1020]] },        // across
      { points: [[490, 1020], [490, 800]] },         // back up to Cedar
    ],
    arrows: [],
  },

  // ORANGE DAY (route 2): Canner → Canner/Livingston → Orange/Canner → up
  // to Willow → west to Foster → down Foster → west to Orange/Edwards →
  // down Orange St → Audubon → Grove → south trunk → Cedar → York loop →
  // up Prospect → east to Whitney.
  {
    id: "orange_day_out", label: "Orange", color: "#E65100",
    segments: [
      { points: [[640, 200], [770, 200]] },         // Canner → Orange (via Canner/Livingston)
      { points: [[770, 200], [770, 170]] },         // up to Orange/Willow
      { points: [[770, 170], [710, 170]] },         // west to Willow/Foster
      { points: [[710, 170], [830, 230]] },         // diag east-down to Foster/Avon
      { points: [[830, 230], [830, 320]] },         // down Foster (Avon → Cottage → Lawrence → Edwards)
      { points: [[830, 320], [770, 290]] },         // diag back to Orange/Edwards
      { points: [[770, 290], [770, 530]] },         // down Orange to Audubon
      { points: [[770, 530], [580, 470]] },         // diag west to Grove
    ],
    arrows: [],
  },
  {
    id: "orange_day_ret", label: "Orange", color: "#E65100", dashed: true,
    segments: [
      { points: [[580, 470], [418, 470]] },         // Grove → Wall (Orange offset x=418)
      { points: [[418, 470], [418, 730]] },         // south trunk to LEPH
      { points: [[418, 730], [490, 800]] },         // diag to Cedar
      { points: [[490, 800], [330, 800]] },         // west to York
      { points: [[330, 800], [330, 920]] },         // down to Elm/York
      { points: [[330, 920], [330, 470]] },         // back up York
      { points: [[330, 470], [418, 470]] },         // east to Wall(N)
      { points: [[418, 470], [418, 215]] },         // up Prospect (Wall → Sachem → Chemistry → Edwards)
      { points: [[418, 215], [640, 300]] },         // diag east to Whitney/Cottage area via Edwards
    ],
    arrows: [],
  },

  // ORANGE NIGHT (route 14): Cedar → York → Elm/York → Wall(N) → Church/Grove →
  // Whitney/Trumbull → SOM → up Whitney (Humphrey/Edwards/Cottage) → Canner →
  // Orange/Edwards → Bishop → Humphrey → Pearl → Audubon → Grove → south trunk →
  // Crown → George → Amistad → Congress/Cedar.
  {
    id: "orange_night", label: "Orange Night", color: "#E6810080", dashed: true,
    segments: [
      { points: [[490, 800], [330, 800]] },           // Cedar → 129 York
      { points: [[330, 800], [330, 920]] },           // down to Elm/York
      { points: [[330, 920], [330, 470]] },           // up York
      { points: [[330, 470], [490, 470]] },           // east to Church/Grove
      { points: [[490, 470], [620, 440]] },           // east to Whitney/Trumbull
      { points: [[620, 440], [580, 340]] },           // back diag to SOM
      { points: [[580, 340], [640, 335]] },           // SOM → Whitney/Edwards
      { points: [[640, 335], [640, 200]] },           // up Whitney (Edwards/Cottage/Linden/Canner)
      { points: [[640, 200], [770, 200]] },           // east to Orange/Canner
      { points: [[770, 200], [770, 290]] },           // down Orange to Edwards
      { points: [[770, 290], [770, 530]] },           // down Orange (Bishop/Humphrey/Pearl/Audubon)
      { points: [[770, 530], [580, 470]] },           // diag west to Grove
      { points: [[580, 470], [420, 470]] },           // Grove → Wall(S) (orange offset)
      { points: [[420, 470], [420, 860]] },           // down trunk to Amistad area
      { points: [[420, 860], [490, 800]] },           // back to Cedar
    ],
    arrows: [],
  },

  // ORANGE EAST (route 17): Cedar → York/Chapel → Elm/Orange → Eagle/Nash →
  // Nash/Willow → Nicoll → Olive corridor → Olive/Wooster (Union/Fair) →
  // Union Station.
  {
    id: "orange_east", label: "Orange East", color: "#E65100",
    segments: [
      { points: [[490, 800], [300, 640]] },           // Cedar → York/Chapel
      { points: [[300, 640], [700, 600]] },           // across to Elm/Orange
      { points: [[700, 600], [830, 470]] },           // NE diag to Eagle/Nash
      { points: [[830, 470], [830, 560]] },           // Eagle/Nash → Nicoll (down)
      { points: [[830, 560], [700, 620]] },           // Nicoll → Olive/Greene
      { points: [[700, 620], [700, 700]] },           // down Olive
      { points: [[700, 700], [580, 800]] },           // Olive → Union/Fair
      { points: [[580, 800], [400, 960]] },           // Union/Fair → Union Station
    ],
    arrows: [],
  },

  // BLUE (route 4): distinct from Blue Day — hits Orange St corridor.
  // Sachem → up Prospect → Huntington → east to Whitney/Canner → Canner →
  // Orange/Canner → down Orange (Willow/Cottage/Edwards/Humphrey/Pearl/Trumbull)
  // → Orange/Grove → Grove → Wall(S) → Phelps → Chapel/State → Union(S) →
  // Amistad → Cedar → York/Chapel → Broadway → Stop&Shop → Elm/York →
  // Wall(N) → Becton → Sachem. (Secondary Blue offset at x=430.)
  {
    id: "blue_r4", label: "Blue", color: "#1565C0",
    segments: [
      { points: [[430, 300], [430, 240]] },           // Sachem → Canner
      { points: [[430, 240], [430, 80]] },            // up Prospect to Huntington
      { points: [[430, 80], [640, 200]] },            // east to Canner/Whitney area
      { points: [[640, 200], [770, 200]] },           // east to Orange/Canner
      { points: [[770, 200], [770, 470]] },           // down Orange (Willow → Trumbull)
      { points: [[770, 470], [770, 500]] },           // → Orange/Grove
      { points: [[770, 500], [580, 470]] },           // west to Grove
      { points: [[580, 470], [430, 470]] },           // → Wall(S)
      { points: [[430, 470], [430, 530]] },           // → Phelps
      { points: [[430, 530], [540, 900]] },           // diag southeast to Chapel/State
      { points: [[540, 900], [330, 960]] },           // Chapel/State → Union(S)
      { points: [[330, 960], [490, 860]] },           // Union(S) → Amistad
      { points: [[490, 860], [490, 800]] },           // Amistad → Cedar
      { points: [[490, 800], [300, 640]] },           // Cedar → York/Chapel
      { points: [[300, 640], [250, 540]] },           // → Broadway/York & Elm/Lynwood
      { points: [[250, 540], [200, 480]] },           // → Stop&Shop
      { points: [[200, 480], [330, 470]] },           // → Elm/York area
      { points: [[330, 470], [430, 470]] },           // east to Wall(N)
      { points: [[430, 470], [430, 300]] },           // up Prospect to Sachem (loop closes)
    ],
    arrows: [],
  },

  // BLUE WEST (route 16): Cedar → Howard/Park → Chapel/Dwight → Howe/Edgewood →
  // Elm/Lynwood → York/Elm → Ashmun/Lock → Canal/Munson → Mansfield/Division →
  // Pauli Murray → Phelps.
  {
    id: "blue_west", label: "Blue West", color: "#00838F",
    segments: [
      { points: [[490, 800], [180, 720]] },           // Cedar → Howard/Park (long diag)
      { points: [[180, 720], [180, 680]] },           // Howard/Park → Chapel/Dwight
      { points: [[180, 680], [200, 600]] },           // → Howe/Edgewood
      { points: [[200, 600], [250, 550]] },           // → Elm/Lynwood
      { points: [[250, 550], [290, 550]] },           // → York/Elm
      { points: [[290, 550], [160, 300]] },           // diag NW to Ashmun/Lock
      { points: [[160, 300], [110, 140]] },           // → Canal/Munson
      { points: [[110, 140], [220, 170]] },           // → Mansfield/Division
      { points: [[220, 170], [110, 360]] },           // → Pauli Murray
      { points: [[110, 360], [400, 530]] },           // → Phelps (diag)
    ],
    arrows: [],
  },

  // BROWN (route 19): Science Park → Winchester/Sachem → 130 Prospect (S) →
  // Wall(S) → Phelps → Union Station → State St → Humphrey/Whitney → Divinity.
  {
    id: "brown", label: "Brown", color: "#795548",
    segments: [
      { points: [[240, 30], [140, 200]] },             // Science Park → Winch/Sachem
      { points: [[140, 200], [400, 360]] },            // across/down to 130 Prospect
      { points: [[400, 360], [400, 470]] },            // → Wall(S)
      { points: [[400, 470], [400, 530]] },            // → Phelps
      { points: [[400, 530], [400, 960]] },            // down trunk to Union
      { points: [[400, 960], [490, 960]] },            // east to State St
      { points: [[490, 960], [640, 360]] },            // NE diag to Humphrey/Whitney
      { points: [[640, 360], [400, 185]] },            // back to Divinity/409 Prospect
    ],
    arrows: [],
  },

  // PINK (route 8): York/Cedar → LEPH → Congress/Cedar → Congress/Howard →
  // Davenport/Howard → Front/Rt 1 → Quigley → VA Entrance → VA Hospital → loop back.
  {
    id: "pink", label: "Pink", color: "#AD1457",
    segments: [
      { points: [[280, 730], [400, 730]] },            // York/Cedar → LEPH
      { points: [[400, 730], [490, 800]] },            // LEPH → Congress/Cedar
      { points: [[490, 800], [220, 800]] },            // Cedar → Congress/Howard
      { points: [[220, 800], [180, 830]] },            // Davenport/Howard
      { points: [[180, 830], [140, 870]] },            // Front/Rt 1 (N)
      { points: [[140, 870], [100, 890]] },            // Quigley (In)
      { points: [[100, 890], [70, 915]] },             // VA Entrance (In)
      { points: [[70, 915], [40, 925]] },              // VA Hospital
      { points: [[40, 925], [70, 935]] },              // VA Entrance (Out)
      { points: [[70, 935], [100, 905]] },             // Quigley (Out)
      { points: [[100, 905], [130, 880]] },            // Front/Rt 1 (S)
    ],
    arrows: [],
  },

  // GREEN (route 9): West Campus / Orange St loop — Orange/Bishop (N) down
  // Orange (N-side) through Edwards/Lawrence/Avon/Willow → Willow corridor →
  // Whitney/Cottage → Orange stops → West Campus buildings (400/600/750/800/900).
  {
    id: "green", label: "Green", color: "#43A047",
    segments: [
      { points: [[770, 350], [770, 170]] },            // Orange/Bishop → up to Willow
      { points: [[770, 170], [680, 150]] },            // Willow/Whitney
      { points: [[680, 150], [640, 300]] },            // diag back to Whitney/Cottage
      { points: [[640, 300], [770, 380]] },            // east to Orange/Humphrey
      { points: [[770, 380], [770, 440]] },            // down Orange (Pearl/Bradley)
      { points: [[770, 440], [50, 960]] },             // LONG diag to West Campus Bldg 400
      { points: [[50, 960], [50, 1060]] },             // down through buildings 400→900
    ],
    arrows: [],
  },

  // PURPLE (route 10): 333 Cedar → 300 George → Church St South → Union(S) →
  // West Haven Station → West Campus buildings → LEPH (back).
  {
    id: "purple", label: "Purple", color: "#7B1FA2",
    segments: [
      { points: [[490, 800], [400, 660]] },            // Cedar → 300 George
      { points: [[400, 660], [400, 1020]] },           // George → Church St South
      { points: [[400, 1020], [330, 960]] },           // → Union(S)
      { points: [[330, 960], [140, 1060]] },           // → West Haven Stn
      { points: [[140, 1060], [50, 960]] },            // → West Campus (start Bldg 400)
      { points: [[50, 960], [50, 1060]] },             // down through buildings
      { points: [[50, 1060], [400, 730]] },            // long return to LEPH
    ],
    arrows: [],
  },

  // GOLD (route 15): Cedar → Howard/Park → Chapel/Dwight → Howe/Edgewood →
  // Elm/Lynwood → Elm/Orange → Olive corridor → Olive/Wooster → Union.
  {
    id: "gold", label: "Gold", color: "#F9A825",
    segments: [
      { points: [[490, 800], [180, 720]] },            // Cedar → Howard/Park
      { points: [[180, 720], [180, 680]] },            // Chapel/Dwight
      { points: [[180, 680], [200, 600]] },            // Howe/Edgewood
      { points: [[200, 600], [250, 550]] },            // Elm/Lynwood
      { points: [[250, 550], [700, 600]] },            // east to Elm/Orange
      { points: [[700, 600], [700, 620]] },            // Olive/Greene
      { points: [[700, 620], [700, 700]] },            // Olive/Chapel
      { points: [[700, 700], [580, 800]] },            // Olive/Wooster (Union/Fair)
      { points: [[580, 800], [400, 960]] },            // → Union Station
    ],
    arrows: [],
  },

  // GROCERY — Trader Joe's (route 6): Peabody → Grove/Temple → Wall(S) → Crown → TJ.
  {
    id: "grocery_tj", label: "Grocery TJ", color: "#5D4037",
    segments: [
      { points: [[640, 395], [580, 470]] },            // Peabody → Grove
      { points: [[580, 470], [400, 470]] },            // Grove → Wall(S)
      { points: [[400, 470], [400, 600]] },            // Wall → Crown
      { points: [[400, 600], [700, 530]] },            // Crown → Trader Joe's (diag)
    ],
    arrows: [],
  },

  // GROCERY — Hamden (route 18): Elm/York → Elm/College → Whitney/Humphrey (N) →
  // Whitney/Cottage (N) → Aldi/Walmart → Shop Rite.
  {
    id: "grocery_ham", label: "Grocery Ham", color: "#8D6E63",
    segments: [
      { points: [[330, 920], [330, 530]] },            // Elm/York → Elm/College (north)
      { points: [[330, 530], [640, 360]] },            // diag NE to Whitney/Humphrey(N)
      { points: [[640, 360], [640, 300]] },            // up Whitney to Cottage
      { points: [[640, 300], [830, 300]] },            // east to Aldi/Walmart
      { points: [[830, 300], [830, 370]] },            // Aldi → Shop Rite
    ],
    arrows: [],
  },

];

// ── Stop ID → Station lookup ───────────────────────────────────────────────

export const stopToStation: Record<number, string> = {};
for (const s of stations) {
  for (const id of s.stopIds) {
    stopToStation[id] = s.id;
  }
}

export const routeColorMap: Record<number, string> = {
  1: "#1565C0", 3: "#C62828", 4: "#1565C0", 13: "#1565C0", 14: "#E65100",
  16: "#00838F", 17: "#E65100", 2: "#E65100",
};

export const routeNameMap: Record<number, string> = {
  1: "Blue", 3: "Red", 4: "Blue", 13: "Blue", 14: "Orange",
  16: "Blue West", 17: "Orange", 2: "Orange",
};
