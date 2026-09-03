/**
 * Destinations a rider is likely to type into the trip planner: Yale places
 * by their campus names, plus the shops, cafes and landmarks around the
 * shuttle network. Shuttle STOPS are matched separately (`geocode.ts`); this
 * list exists for the things a rider calls by a name no stop carries —
 * "Elena's", "Commons", "KBT", "Stop and Shop".
 *
 * ⚠️ Hand-entered coordinates rot silently. Every entry was VERIFIED against
 * OpenStreetMap on 2026-09-02 (Photon, then Nominatim where Photon was empty
 * or ambiguous; the OSM object id is the trailing comment on each line) and
 * is pinned to the shuttle stop that serves it (`anchorStop`, the nearest of
 * the 172 live stops; `geocode.test.ts` recomputes that from the checked-in
 * stop fixture, so a moved or mistyped coordinate fails the suite instead of
 * sending a rider across town). The 2026-08-31 audit found seven of fourteen
 * hand-typed entries wrong, one by 1.2 km; the 2026-09-02 audit moved five
 * more by 63–168 m. **If you add or move an entry, look it up in OSM and set
 * its anchor** — do not eyeball it. The audit pipeline (candidates, cached
 * OSM responses, overrides, the drop list with reasons) is recorded in the
 * PR that introduced this file.
 *
 * One entry per physical place. `aliases` are the OTHER names riders type for
 * the same place — the campus initialism ("KBT", "SOM"), the colloquial
 * name ("the commons", "med school"), the former name ("Romeo & Cesare's"),
 * the street address. They exist because on 2026-09-02 the live geocoder
 * returned nothing for "kbt", "commons" and "medical school". An alias scores
 * exactly like the label (see `geocode.ts`). No misspellings: the matcher's
 * fuzzy tier handles those. Places that share a building are ONE entry with
 * the other name as an alias; adjacent-but-distinct places (a cafe next to a
 * museum) stay separate even when metres apart, because folding would hide
 * the label a rider types.
 *
 * Nothing here is farther than 500 m from a stop; candidates beyond that
 * (Edgewood Park, the Yale Bowl) are simply not shuttle destinations.
 */
export type Landmark = {
  label: string;
  lat: number;
  lon: number;
  aliases?: readonly string[];
  /** The live stop nearest the place — what pins the coordinate in the tests. */
  anchorStop: string;
};

export const LANDMARKS: readonly Landmark[] = [
  // -- Campus areas ----------------------------------------------------------
  { label: "25 Science Park", lat: 41.320867, lon: -72.928993, aliases: ["science park", "yale science park", "science park at yale", "150 munson"], anchorStop: "Canal / Munson" }, // OSM W76235255
  { label: "Cross Campus", lat: 41.310464, lon: -72.92714, aliases: ["xc"], anchorStop: "College / Wall (N)" }, // OSM R5421111
  { label: "Old Campus", lat: 41.308751, lon: -72.928647, aliases: ["durfee's", "durfees", "vanderbilt hall", "lawrance hall", "phelps hall", "welch hall", "bingham hall", "farnam hall", "durfee hall", "connecticut hall", "lanman-wright", "first year", "battell", "battell chapel"], anchorStop: "Phelps Gate" }, // OSM W211737531
  { label: "Undergraduate Admissions (38 Hillhouse)", lat: 41.314572, lon: -72.923772, aliases: ["admissions", "admissions office", "38 hillhouse"], anchorStop: "130 Prospect Street (S)" }, // OSM W225487554
  { label: "West Campus Conference Center", lat: 41.258411, lon: -72.989228, aliases: ["conference center", "wccc"], anchorStop: "Building 800" }, // OSM W364600438
  { label: "Woolsey Hall", lat: 41.311244, lon: -72.926176, aliases: ["woolsey", "memorial hall", "hewitt quadrangle", "beinecke plaza", "sprague hall", "sprague", "morse recital hall"], anchorStop: "College / Wall (S)" }, // OSM W139759935
  { label: "Yale Visitor Center", lat: 41.309212, lon: -72.92566, aliases: ["visitor center", "visitors center", "tours", "campus tour"], anchorStop: "Elm / College" }, // OSM W216863205
  { label: "Yale West Campus", lat: 41.257131, lon: -72.98967, aliases: ["west campus", "wc", "orange campus", "west campus main"], anchorStop: "Building 600" }, // OSM R3861723

  // -- Residential colleges --------------------------------------------------
  { label: "Benjamin Franklin College", lat: 41.314734, lon: -72.925016, aliases: ["franklin", "ben franklin", "bf college", "new colleges", "bf"], anchorStop: "130 Prospect Street (S)" }, // OSM R5424658
  { label: "Berkeley College", lat: 41.311082, lon: -72.927325, aliases: ["berkeley", "bk"], anchorStop: "College / Wall (S)" }, // OSM R6084168
  { label: "Branford College", lat: 41.309671, lon: -72.930083, aliases: ["branford", "harkness tower"], anchorStop: "Library Walk" }, // OSM R2837570
  { label: "Davenport College", lat: 41.310488, lon: -72.931744, aliases: ["davenport", "dport", "dc"], anchorStop: "Elm / York (TYCO)" }, // OSM R2858948
  { label: "Ezra Stiles College", lat: 41.312757, lon: -72.931608, aliases: ["stiles", "ezra stiles", "es"], anchorStop: "Payne Whitney Gym" }, // OSM R5463395
  { label: "Grace Hopper College", lat: 41.309989, lon: -72.92692, aliases: ["hopper", "grace hopper", "gh", "calhoun"], anchorStop: "Elm / College" }, // OSM R2840328
  { label: "Jonathan Edwards College", lat: 41.309041, lon: -72.9299, aliases: ["je", "jonathan edwards"], anchorStop: "Library Walk" }, // OSM W363808899
  { label: "Morse College", lat: 41.312857, lon: -72.929688, aliases: ["morse", "mc"], anchorStop: "Wall / York" }, // OSM R5463394
  { label: "Pauli Murray College", lat: 41.315712, lon: -72.924721, aliases: ["murray", "pauli murray", "pm", "new colleges"], anchorStop: "Prospect / Sachem (S)" }, // OSM R5424657
  { label: "Pierson College", lat: 41.310194, lon: -72.932383, aliases: ["pierson", "pc"], anchorStop: "Library Walk" }, // OSM R5421070
  { label: "Saybrook College", lat: 41.31015, lon: -72.92915, aliases: ["saybrook", "sy"], anchorStop: "Elm / High" }, // OSM R2837571
  { label: "Silliman College", lat: 41.310449, lon: -72.924982, aliases: ["silliman", "sm", "good life center"], anchorStop: "College / Wall (N)" }, // OSM R5405274
  { label: "Timothy Dwight College", lat: 41.310338, lon: -72.923648, aliases: ["td", "timothy dwight"], anchorStop: "Wall / Church" }, // OSM R2868459
  { label: "Trumbull College", lat: 41.310696, lon: -72.929575, aliases: ["trumbull", "tc"], anchorStop: "Elm / York" }, // OSM R3634728

  // -- Libraries -------------------------------------------------------------
  { label: "Bass Library", lat: 41.310591, lon: -72.927578, aliases: ["bass", "bass lib", "cross campus library"], anchorStop: "Elm / College" }, // OSM R5420164
  { label: "Beinecke Library", lat: 41.311597, lon: -72.927324, aliases: ["beinecke", "rare book library"], anchorStop: "College / Wall (S)" }, // OSM W114134159
  { label: "Cushing/Whitney Medical Library", lat: 41.303002, lon: -72.933244, aliases: ["cushing", "medical library", "med library", "cushing library"], anchorStop: "333 Cedar" }, // OSM N367138655
  { label: "Sterling Memorial Library", lat: 41.311184, lon: -72.929022, aliases: ["sterling", "sml", "sterling library", "poorvu center", "ctl", "center for teaching and learning", "manuscripts and archives"], anchorStop: "York / Elm" }, // OSM R2840329

  // -- Academic buildings ----------------------------------------------------
  { label: "Arthur K. Watson Hall (AKW)", lat: 41.313078, lon: -72.924852, aliases: ["akw", "watson hall", "computer science", "cs department", "51 prospect"], anchorStop: "Becton / 15 Prospect" }, // OSM W217270615
  { label: "Bass Center for Molecular and Structural Biology", lat: 41.318095, lon: -72.921835, aliases: ["bass center", "266 whitney"], anchorStop: "Lot 22 - Whitney / Humphrey" }, // OSM R14221284
  { label: "Becton Center", lat: 41.312672, lon: -72.925125, aliases: ["becton", "ceid", "center for engineering innovation and design", "15 prospect"], anchorStop: "Becton / 15 Prospect" }, // OSM W217270619
  { label: "Dunham Laboratory", lat: 41.312324, lon: -72.92454, aliases: ["dunham", "dunham lab", "seas", "school of engineering", "engineering", "10 hillhouse"], anchorStop: "Becton / 15 Prospect" }, // OSM W217270620
  { label: "Hendrie Hall", lat: 41.309528, lon: -72.926052, aliases: ["hendrie", "adams center", "school of music", "165 elm"], anchorStop: "College / Wall (N)" }, // OSM R6888590
  { label: "Horchow Hall", lat: 41.315448, lon: -72.922402, aliases: ["horchow", "jackson school", "jackson school of global affairs", "global affairs", "55 hillhouse"], anchorStop: "Sachem / Whitney" }, // OSM W210441924
  { label: "Humanities Quadrangle (HQ)", lat: 41.312309, lon: -72.929127, aliases: ["hq", "humanities quad", "hgs", "hall of graduate studies", "320 york"], anchorStop: "Wall / York" }, // OSM R2845114
  { label: "Kline Tower (Kline Biology Tower)", lat: 41.317239, lon: -72.922549, aliases: ["kbt", "kline biology tower", "kline tower", "marx library", "marx science and social science library", "csssi", "science hill", "219 prospect"], anchorStop: "SCL" }, // OSM W228325196
  { label: "Kroon Hall", lat: 41.316796, lon: -72.923352, aliases: ["kroon", "school of the environment", "yse", "forestry school", "fes", "195 prospect"], anchorStop: "Prospect / Sachem (N)" }, // OSM W217341970
  { label: "Linsly-Chittenden Hall (LC)", lat: 41.308596, lon: -72.929478, aliases: ["lc", "linsly chittenden", "63 high"], anchorStop: "Phelps Gate" }, // OSM W139753884
  { label: "Loria Center", lat: 41.309022, lon: -72.931564, aliases: ["loria", "history of art", "190 york"], anchorStop: "180 York (A&A)" }, // OSM W224889714
  { label: "Luce Hall", lat: 41.314441, lon: -72.924354, aliases: ["luce", "macmillan center", "34 hillhouse"], anchorStop: "Prospect / Trumbull" }, // OSM W363329574
  { label: "Malone Engineering Center", lat: 41.313374, lon: -72.924818, aliases: ["malone", "biomedical engineering", "55 prospect"], anchorStop: "Prospect / Trumbull" }, // OSM W217301902
  { label: "Osborn Memorial Laboratories", lat: 41.316422, lon: -72.923921, aliases: ["osborn", "oml", "165 prospect"], anchorStop: "Prospect / Sachem (N)" }, // OSM W217341973
  { label: "Rosenkranz Hall", lat: 41.314701, lon: -72.924551, aliases: ["rosenkranz", "political science", "115 prospect"], anchorStop: "130 Prospect Street (S)" }, // OSM W363327921
  { label: "Rudolph Hall (Art & Architecture)", lat: 41.308769, lon: -72.931886, aliases: ["rudolph", "a&a", "a and a", "art and architecture", "school of architecture", "architecture school", "180 york", "haas", "haas library", "arts library", "haas family arts library"], anchorStop: "180 York (A&A)" }, // OSM W224889715
  { label: "Sage Hall", lat: 41.317143, lon: -72.923761, aliases: ["sage", "205 prospect"], anchorStop: "SCL" }, // OSM W228473355
  { label: "Sheffield-Sterling-Strathcona Hall (SSS)", lat: 41.311929, lon: -72.925217, aliases: ["sss", "sheffield sterling strathcona", "1 prospect"], anchorStop: "College / Grove (N)" }, // OSM W217270625
  { label: "Sloane Physics Laboratory", lat: 41.317283, lon: -72.923023, aliases: ["sloane", "spl", "physics", "217 prospect"], anchorStop: "SCL" }, // OSM W228473356
  { label: "Sterling Chemistry Laboratory", lat: 41.318225, lon: -72.922921, aliases: ["scl", "sterling chem", "chemistry", "225 prospect", "kcl", "kline chemistry lab", "kline chemistry laboratory", "chemistry building"], anchorStop: "Chemistry / 225 Prospect" }, // OSM W363820905
  { label: "Watson Center", lat: 41.315616, lon: -72.923559, aliases: ["watson", "60 sachem", "yale watson center"], anchorStop: "Prospect / Sachem (N)" }, // OSM W238532528
  { label: "William L. Harkness Hall (WLH)", lat: 41.310684, lon: -72.926997, aliases: ["wlh", "harkness hall", "100 wall"], anchorStop: "College / Wall (N)" }, // OSM W139420880
  { label: "Wright Laboratory", lat: 41.319018, lon: -72.920743, aliases: ["wright lab", "wnsl", "272 whitney"], anchorStop: "Lot 22 - Whitney / Humphrey" }, // OSM W228473354
  { label: "Yale Science Building (YSB)", lat: 41.317405, lon: -72.921762, aliases: ["ysb", "science building", "science hill", "260 whitney"], anchorStop: "Lot 22 - Whitney / Humphrey" }, // OSM W719112933

  // -- Professional schools --------------------------------------------------
  { label: "Divinity School", lat: 41.3232, lon: -72.922508, aliases: ["divinity", "yds", "divinity library", "marquand chapel", "sterling divinity quadrangle", "409 prospect"], anchorStop: "Divinity / 409 Prospect" }, // OSM R5730472
  { label: "School of Art (Green Hall)", lat: 41.308301, lon: -72.933003, aliases: ["art school", "school of art", "green hall", "1156 chapel", "iseman theater", "iseman"], anchorStop: "York / Chapel" }, // OSM W224973110
  { label: "School of Management (SOM)", lat: 41.315171, lon: -72.920475, aliases: ["som", "evans hall", "business school", "yale som", "165 whitney"], anchorStop: "SOM" }, // OSM R3959340
  { label: "School of Medicine (YSM)", lat: 41.303186, lon: -72.933746, aliases: ["med school", "medical school", "ysm", "sterling hall of medicine", "shm", "333 cedar", "medicine", "harkness auditorium (shm)", "harkness auditorium", "med school auditorium"], anchorStop: "333 Cedar" }, // OSM W180193233
  { label: "School of Nursing (West Campus)", lat: 41.255831, lon: -72.992846, aliases: ["nursing", "nursing school", "ysn", "400 west campus"], anchorStop: "Building 400" }, // OSM W336607422
  { label: "School of Public Health (YSPH)", lat: 41.303735, lon: -72.932155, aliases: ["ysph", "public health", "leph", "60 college", "epidemiology"], anchorStop: "LEPH / 60 College" }, // OSM W239527110
  { label: "Yale Law School", lat: 41.312032, lon: -72.927781, aliases: ["law school", "yls", "sterling law building", "law library", "lillian goldman law library", "127 wall", "law"], anchorStop: "Wall / York" }, // OSM R2840491

  // -- Student life ----------------------------------------------------------
  { label: "Afro-American Cultural Center", lat: 41.309406, lon: -72.93288, aliases: ["af am house", "afam house", "the house", "afro american cultural center", "211 park"], anchorStop: "180 York (A&A)" }, // OSM W224889712
  { label: "Asian American Cultural Center", lat: 41.306987, lon: -72.931583, aliases: ["aacc", "asian american center", "295 crown"], anchorStop: "York / Crown" }, // OSM N11606240137
  { label: "Dwight Hall", lat: 41.308947, lon: -72.929297, aliases: ["dwight", "dwight chapel", "67 high"], anchorStop: "Phelps Gate" }, // OSM W139753858
  { label: "Graduate & Professional Student Center (GPSCY)", lat: 41.309255, lon: -72.931882, aliases: ["gpscy", "gypsy", "grad center", "204 york", "gryphon", "gryphons", "gryphon's pub", "the gryphon"], anchorStop: "180 York (A&A)" }, // OSM W224973083
  { label: "La Casa Cultural", lat: 41.307061, lon: -72.931765, aliases: ["la casa", "latino cultural center", "301 crown"], anchorStop: "York / Crown" }, // OSM N11606240136
  { label: "Native American Cultural Center", lat: 41.306961, lon: -72.93118, aliases: ["nacc", "native american center", "26 high"], anchorStop: "York / Crown" }, // OSM N11606236056
  { label: "Schwarzman Center", lat: 41.311808, lon: -72.92644, aliases: ["commons", "the commons", "schwarzman", "schwarzman commons", "the elm", "the well", "dome"], anchorStop: "College / Grove (N)" }, // OSM W363426802
  { label: "Slifka Center", lat: 41.31018, lon: -72.925293, aliases: ["slifka", "hillel", "jewish life", "80 wall"], anchorStop: "College / Wall (N)" }, // OSM W114626279
  { label: "St. Thomas More Chapel", lat: 41.310967, lon: -72.932378, aliases: ["stm", "saint thomas more", "catholic chapel", "catholic center", "268 park"], anchorStop: "Elm / Lynwood" }, // OSM R5463450
  { label: "Yale Farm", lat: 41.320491, lon: -72.921337, aliases: ["the farm", "sustainable food program", "345 edwards"], anchorStop: "Prospect / Edwards" }, // OSM W45092131

  // -- Athletics -------------------------------------------------------------
  { label: "Ingalls Rink", lat: 41.316811, lon: -72.925004, aliases: ["the whale", "hockey rink", "ingalls", "73 sachem"], anchorStop: "Prospect / Sachem (S)" }, // OSM W76235245
  { label: "Payne Whitney Gym", lat: 41.313722, lon: -72.931086, aliases: ["pwg", "gym", "payne whitney", "lanman center", "lanman", "the gym", "70 tower parkway"], anchorStop: "Payne Whitney Gym" }, // OSM W49602467

  // -- Museums ---------------------------------------------------------------
  { label: "McGivney Pilgrimage Center (Knights of Columbus Museum)", lat: 41.30212, lon: -72.923823, aliases: ["knights of columbus", "mcgivney center", "1 state street"], anchorStop: "Union / Fair" }, // OSM R2248306
  { label: "New Haven Museum", lat: 41.314014, lon: -72.921959, aliases: ["historical society", "114 whitney"], anchorStop: "Whitney / Trumbull" }, // OSM W143303781
  { label: "Peabody Museum", lat: 41.316034, lon: -72.921086, aliases: ["peabody", "natural history museum", "dinosaur museum", "170 whitney"], anchorStop: "Peabody Museum / Whitney / Sachem" }, // OSM R14221283
  { label: "Yale Center for British Art", lat: 41.307896, lon: -72.930861, aliases: ["ycba", "british art", "british art center", "1080 chapel"], anchorStop: "Chapel / York" }, // OSM W139753883
  { label: "Yale University Art Gallery", lat: 41.308435, lon: -72.93088, aliases: ["yuag", "art gallery", "the gallery", "1111 chapel"], anchorStop: "Chapel / York" }, // OSM R6686912

  // -- Medical campus and hospitals ------------------------------------------
  { label: "100 College Street", lat: 41.304191, lon: -72.931689, aliases: ["100 college", "alexion", "100 college st"], anchorStop: "LEPH / 60 College" }, // OSM W266150495
  { label: "Smilow Cancer Hospital", lat: 41.3051, lon: -72.93584, aliases: ["smilow", "cancer center", "yale cancer center", "35 park"], anchorStop: "Howard / Park" }, // OSM R5641557
  { label: "The Anlyan Center (TAC)", lat: 41.30118, lon: -72.934072, aliases: ["tac", "anlyan", "300 cedar"], anchorStop: "Gilbert / Cedar" }, // OSM W232595709
  { label: "VA Hospital (West Haven)", lat: 41.283664, lon: -72.959832, aliases: ["va", "the va", "veterans hospital", "va medical center", "west haven va", "veterans affairs"], anchorStop: "VA Entrance Inbound" }, // OSM W42735113
  { label: "Yale Health Center", lat: 41.315731, lon: -72.927521, aliases: ["yale health", "health center", "student health", "yuhs", "55 lock", "pharmacy", "acute care"], anchorStop: "Winchester / Sachem" }, // OSM W217340232
  { label: "Yale New Haven Hospital Saint Raphael Campus", lat: 41.310144, lon: -72.942931, aliases: ["st raphael", "saint raphael", "st raphaels", "srh", "1450 chapel"], anchorStop: "Chapel / Dwight" }, // OSM W442001687
  { label: "Yale Physicians Building", lat: 41.302563, lon: -72.936326, aliases: ["ypb", "physicians building", "800 howard"], anchorStop: "Davenport / Howard" }, // OSM W232595708
  { label: "Yale-New Haven Hospital", lat: 41.304312, lon: -72.936013, aliases: ["ynhh", "hospital", "yale new haven hospital", "children's hospital", "emergency room", "er", "emergency department", "20 york"], anchorStop: "Howard / Park" }, // OSM W114193509

  // -- Transit ---------------------------------------------------------------
  { label: "State Street Station", lat: 41.30473, lon: -72.922003, aliases: ["state st station", "state street", "shore line east", "hartford line"], anchorStop: "State St Station" }, // OSM N6901137794
  { label: "Union Station", lat: 41.297523, lon: -72.926621, aliases: ["train station", "amtrak", "metro north", "metro-north", "new haven station", "railroad station", "50 union ave"], anchorStop: "Union Station (N)" }, // OSM N6097540133
  { label: "West Haven Station", lat: 41.271153, lon: -72.963243, aliases: ["west haven train station", "west haven metro north"], anchorStop: "West Haven Train Station" }, // OSM W411211585

  // -- Groceries and pharmacies ----------------------------------------------
  { label: "Aldi / Walmart (Hamden)", lat: 41.37512, lon: -72.91709, aliases: ["aldi", "walmart", "hamden walmart"], anchorStop: "Aldi/Walmart" }, // OSM W630282072
  { label: "Atticus Market", lat: 41.321363, lon: -72.911948, aliases: ["romeo and cesares", "romeos", "romeo & cesare's", "771 orange"], anchorStop: "Orange / Willow (N)" }, // OSM N470706373
  { label: "CVS (Church St)", lat: 41.306104, lon: -72.925482, aliases: ["cvs", "cvs pharmacy", "pharmacy"], anchorStop: "Chapel / Church" }, // OSM N2412787847
  { label: "Elm City Market", lat: 41.305271, lon: -72.923448, aliases: ["elm city co-op", "co-op market", "chapel street market"], anchorStop: "Chapel / State Elm City Market" }, // OSM N1801930795
  { label: "Good Nature Market", lat: 41.311777, lon: -72.922352, aliases: ["good nature", "gourmet heaven", "gheav"], anchorStop: "Whitney / Audubon" }, // OSM N2469492025
  { label: "Nica's Market", lat: 41.316586, lon: -72.915592, aliases: ["nicas"], anchorStop: "Orange / Bishop (N)" }, // OSM N183611496
  { label: "P&M Orange Street Market", lat: 41.319965, lon: -72.913062, aliases: ["p and m", "orange street market", "pm market"], anchorStop: "Orange / Cottage" }, // OSM N2383870592
  { label: "ShopRite (Hamden)", lat: 41.36879, lon: -72.92047, aliases: ["shop rite", "shoprite"], anchorStop: "Shop Rite" }, // OSM N3449770445
  { label: "Stop & Shop (Whalley Ave)", lat: 41.315041, lon: -72.938202, aliases: ["stop and shop", "stop n shop", "whalley stop and shop", "grocery store"], anchorStop: "Stop & Shop" }, // OSM W141129254; sits ON the stop (77 m from the store polygon) so the two merge into one row, as the grocery-run entries do
  { label: "Trader Joe's (Milford)", lat: 41.251309, lon: -73.017729, aliases: ["trader joes", "tj", "tjs"], anchorStop: "Trader Joe's" }, // OSM N3106269418
  { label: "Walgreens (York St)", lat: 41.306167, lon: -72.934017, aliases: ["walgreens", "pharmacy", "drugstore"], anchorStop: "129 York" }, // OSM W114136522

  // -- Shops -----------------------------------------------------------------
  { label: "Apple Store (Broadway)", lat: 41.311853, lon: -72.93101, aliases: ["apple", "apple store", "shops at yale"], anchorStop: "Broadway / Park" }, // OSM N2719820443
  { label: "Yale Bookstore", lat: 41.312017, lon: -72.931088, aliases: ["bookstore", "barnes and noble", "barnes & noble", "yale barnes and noble"], anchorStop: "Broadway / Park" }, // OSM N2719820436

  // -- Cafes, restaurants and bars -------------------------------------------
  { label: "Archie Moore's", lat: 41.321407, lon: -72.910523, aliases: ["archie moores", "archies", "wings", "188 willow"], anchorStop: "Willow / Foster" }, // OSM N299708928
  { label: "Arethusa Farm Dairy", lat: 41.307405, lon: -72.929298, aliases: ["arethusa", "arethusa ice cream", "1020 chapel"], anchorStop: "Chapel / College" }, // OSM N2760039180
  { label: "Ashley's Ice Cream", lat: 41.311033, lon: -72.929949, aliases: ["ashleys", "ashley's", "ice cream", "280 york"], anchorStop: "Broadway / York" }, // OSM N2719756863
  { label: "Atticus Bookstore Cafe", lat: 41.307953, lon: -72.930644, aliases: ["atticus", "atticus cafe", "1082 chapel"], anchorStop: "Chapel / York" }, // OSM N2373828306
  { label: "BAR (Crown St)", lat: 41.306176, lon: -72.930261, aliases: ["bar", "bar pizza", "mashed potato pizza", "254 crown"], anchorStop: "College / Crown" }, // OSM N430030530
  { label: "Blue State Coffee (Cedar St)", lat: 41.301817, lon: -72.933294, aliases: ["blue state", "blue state cedar", "301 cedar"], anchorStop: "Congress / Cedar" }, // OSM N2077027965
  { label: "Book Trader Cafe", lat: 41.308422, lon: -72.931987, aliases: ["book trader", "booktrader", "1140 chapel"], anchorStop: "York / Chapel" }, // OSM N2759702155
  { label: "Claire's Corner Copia", lat: 41.307265, lon: -72.928957, aliases: ["claires", "claire's", "corner copia", "1000 chapel"], anchorStop: "Chapel / College" }, // OSM N1293332877
  { label: "East Rock Brewing Company", lat: 41.322055, lon: -72.907055, aliases: ["east rock brewing", "east rock brewery", "brewery", "285 nicoll"], anchorStop: "Nash / Willow" }, // OSM N6236258494
  { label: "East Rock Coffee", lat: 41.31985, lon: -72.913003, aliases: ["49 cottage"], anchorStop: "Orange / Cottage" }, // OSM N9294694244
  { label: "Elena's on Orange", lat: 41.322952, lon: -72.910805, aliases: ["elenas", "elenas ice cream", "elena's ice cream"], anchorStop: "Orange / Canner" }, // OSM N2473734444
  { label: "Frank Pepe Pizzeria", lat: 41.302965, lon: -72.916958, aliases: ["pepes", "pepe's", "frank pepe", "pepe's pizza", "157 wooster"], anchorStop: "Olive / Wooster" }, // OSM N2567417096
  { label: "G Cafe Bakery", lat: 41.30576, lon: -72.923917, aliases: ["g cafe", "gcafe", "g-cafe", "141 orange"], anchorStop: "Chapel / State Elm City Market" }, // OSM N3444751937
  { label: "Insomnia Cookies", lat: 41.306535, lon: -72.929422, aliases: ["insomnia", "cookies"], anchorStop: "College / Crown" }, // OSM N2563033740
  { label: "Junzi Kitchen", lat: 41.311129, lon: -72.93034, aliases: ["junzi", "21 broadway"], anchorStop: "Broadway / York" }, // OSM N8910620396
  { label: "Koffee?", lat: 41.31155, lon: -72.92192, aliases: ["koffee", "koffee on audubon", "104 audubon"], anchorStop: "Whitney / Audubon" }, // OSM N470632969
  { label: "Louis' Lunch", lat: 41.306474, lon: -72.930408, aliases: ["louis lunch", "louis", "hamburger", "261 crown"], anchorStop: "College / Crown" }, // OSM N2122108492
  { label: "Lupi-Legna Bakery", lat: 41.300835, lon: -72.933212, aliases: ["lupi legna bakery"], anchorStop: "Amistand / Cedar Weekend Blue" }, // OSM N3454951826
  { label: "Mamoun's Falafel", lat: 41.310327, lon: -72.934555, aliases: ["mamouns", "falafel", "85 howe"], anchorStop: "Howe / Edgewood" }, // OSM N2191968199
  { label: "Modern Apizza", lat: 41.313825, lon: -72.912834, aliases: ["modern", "modern pizza", "874 state"], anchorStop: "Nicoll / Edwards" }, // OSM N470623969
  { label: "One 6 Three", lat: 41.32108, lon: -72.90911, aliases: ["one6three", "163", "one six three", "163 pizza", "one 6 three pizza"], anchorStop: "Willow / Foster" }, // OSM N3099233997
  { label: "Pataka", lat: 41.312649, lon: -72.933259, aliases: ["pataka indian"], anchorStop: "Elm / Lynwood" }, // OSM N2637704331
  { label: "Rubamba", lat: 41.306923, lon: -72.930973, aliases: ["arepas", "25 high"], anchorStop: "York / Crown" }, // OSM N11606236058
  { label: "Sally's Apizza", lat: 41.303057, lon: -72.920077, aliases: ["sallys", "sally's", "wooster street pizza", "237 wooster"], anchorStop: "Olive / Wooster" }, // OSM N2567417097
  { label: "Shake Shack", lat: 41.307009, lon: -72.928393, aliases: ["986 chapel"], anchorStop: "Chapel / College" }, // OSM N2760039198
  { label: "Sherkaan", lat: 41.312009, lon: -72.930715, aliases: ["65 broadway"], anchorStop: "Broadway / Park" }, // OSM N2719765603
  { label: "Tomatillo", lat: 41.311191, lon: -72.931701, aliases: ["taco joint", "320 elm"], anchorStop: "Broadway / Park" }, // OSM N2657096153
  { label: "Willoughby's Coffee (Church St)", lat: 41.310424, lon: -72.922827, aliases: ["willoughbys church", "willoughby's church street"], anchorStop: "Church / Grove" }, // OSM N2373871290
  { label: "Willoughby's Coffee (York St)", lat: 41.308984, lon: -72.931471, aliases: ["willoughbys", "willoughby's york"], anchorStop: "180 York (A&A)" }, // OSM N2639180015
  { label: "Yorkside Pizza", lat: 41.311207, lon: -72.92983, aliases: ["yorkside", "288 york"], anchorStop: "York / Elm" }, // OSM N2719756869

  // -- Parks and public places -----------------------------------------------
  { label: "East Rock Park (College Woods)", lat: 41.325916, lon: -72.910674, aliases: ["east rock", "east rock park", "college woods", "the rock"], anchorStop: "Orange / Canner" }, // OSM W773006198
  { label: "Edgerton Park", lat: 41.333726, lon: -72.914384, aliases: ["edgerton"], anchorStop: "Whitney / Huntington" }, // OSM W43437653
  { label: "Grove Street Cemetery", lat: 41.31335, lon: -72.926841, aliases: ["cemetery", "grove st cemetery"], anchorStop: "Becton / 15 Prospect" }, // OSM W43437557
  { label: "Marsh Botanical Garden", lat: 41.321675, lon: -72.924629, aliases: ["marsh gardens", "botanical garden", "greenhouse"], anchorStop: "Prospect / Hillside" }, // OSM W40783723
  { label: "New Haven Green", lat: 41.308017, lon: -72.927059, aliases: ["the green", "green", "downtown", "bus hub", "ct transit"], anchorStop: "Phelps Gate" }, // OSM R11597767
  { label: "Wooster Square", lat: 41.304758, lon: -72.917775, aliases: ["wooster", "cherry blossoms"], anchorStop: "Court / Olive" }, // OSM W43437030

  // -- Venues ----------------------------------------------------------------
  { label: "College Street Music Hall", lat: 41.306665, lon: -72.92931, aliases: ["music hall", "csmh", "238 college"], anchorStop: "College / Crown" }, // OSM N3688823675
  { label: "Criterion Cinemas", lat: 41.304584, lon: -72.928672, aliases: ["criterion", "movie theater", "cinema", "86 temple"], anchorStop: "Church / George" }, // OSM N470646424
  { label: "Shubert Theatre", lat: 41.306331, lon: -72.928817, aliases: ["shubert", "the shubert", "247 college"], anchorStop: "College / Crown" }, // OSM W142323797
  { label: "Toad's Place", lat: 41.311524, lon: -72.929635, aliases: ["toads", "toad's", "300 york"], anchorStop: "York / Elm" }, // OSM W960079261
  { label: "Yale Cabaret", lat: 41.30957, lon: -72.932714, aliases: ["cabaret", "217 park"], anchorStop: "180 York (A&A)" }, // OSM N3686420014
  { label: "Yale Repertory Theatre", lat: 41.30814, lon: -72.931581, aliases: ["yale rep", "the rep", "rep theatre", "1120 chapel", "drama school", "school of drama", "david geffen school of drama", "geffen", "university theatre", "university theater"], anchorStop: "Chapel / York" }, // OSM W142280415

  // -- Hotels ----------------------------------------------------------------
  { label: "Graduate New Haven", lat: 41.308884, lon: -72.93247, aliases: ["graduate hotel", "the graduate", "1151 chapel", "old blue"], anchorStop: "180 York (A&A)" }, // OSM N2759702156
  { label: "Omni New Haven Hotel", lat: 41.305677, lon: -72.927325, aliases: ["omni", "omni hotel", "155 temple"], anchorStop: "Chapel / Church" }, // OSM N2469485883
  { label: "The Study at Yale", lat: 41.309106, lon: -72.932975, aliases: ["the study", "study hotel", "heirloom", "1157 chapel"], anchorStop: "180 York (A&A)" }, // OSM N4088137294

  // -- Civic -----------------------------------------------------------------
  { label: "New Haven City Hall", lat: 41.307378, lon: -72.92433, aliases: ["city hall", "165 church"], anchorStop: "Elm / Orange" }, // OSM W39267857
  { label: "New Haven Free Public Library", lat: 41.309007, lon: -72.924766, aliases: ["public library", "nhfpl", "ives library", "city library", "133 elm"], anchorStop: "Wall / Church" }, // OSM W141163194
  { label: "New Haven Superior Court", lat: 41.309527, lon: -72.922894, aliases: ["courthouse", "superior court", "235 church", "jury duty"], anchorStop: "Church Wall" }, // OSM W141164127
  { label: "Ninth Square", lat: 41.305025, lon: -72.924922, aliases: ["9th square"], anchorStop: "Chapel / Church" }, // OSM W777642209
  { label: "Yale Police (101 Ashmun)", lat: 41.315822, lon: -72.928726, aliases: ["yale police", "ypd", "rose center", "police"], anchorStop: "Ashmun / Lock" }, // OSM N511976767
  { label: "Yale Station Post Office", lat: 41.309901, lon: -72.928555, aliases: ["yale station", "yale post office", "campus post office"], anchorStop: "Elm / High" }, // OSM N359283573
];
