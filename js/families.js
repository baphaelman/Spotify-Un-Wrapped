// Broad families for MusicBrainz genres, so the Genres view shows a few bands instead of hundreds of slivers
// (see docs/genres.md). Pure, with no imports: a genre maps to a family by OVERRIDES, then the first matching
// rule in RULES, else "Other".
//
// Why "Chill & ambient" is its own family: ambient, downtempo, chillwave, lo-fi and trip hop are music people put
// on to study or wind down, and they'd vanish into Electronic beside house and drum and bass, which are music
// to move to. Kept apart, the chart tells those two kinds of listening apart. Lo-fi hip hop and instrumental hip
// hop still go to Hip hop, as beats.

// In the order the view lists them. Other stays last.
export const FAMILIES = [
  "Hip hop", "Pop", "R&B & soul", "Electronic", "Chill & ambient", "Rock", "Metal", "Jazz & blues",
  "Folk & country", "Latin", "Reggae & Caribbean", "World", "Classical", "Spoken & comedy", "Other",
];

// Words that describe how music sounds rather than what style it is ("experimental", "instrumental"). They're
// skipped when an artist has real styles too, and otherwise stand for the family given here.
const DESCRIPTORS = {
  "instrumental": "Other",
  "experimental": "Other",
  "avant-garde": "Other",
  "psychedelic": "Rock",
  "progressive": "Rock",
  "lo-fi": "Chill & ambient",
  "singer-songwriter": "Folk & country",
  "ballad": "Pop",
  "christmas music": "Pop",
  "children's music": "Pop",
  "lullaby": "Pop",
  "drinking song": "Folk & country",
  "work song": "Folk & country",
  "football chant": "Other",
  "military cadence": "Other",
  "non-music": "Other",
};

// Genres named family by family, checked before the rules: names that cross two families ("rap rock", "synth-pop",
// "funk rock") or that a keyword would misread, and styles no keyword reaches, mostly regional ones
const NAMED = {
  "Hip hop": `
    afroswing|bounce|chap hop|chicago bop|chipmunk soul|chopper|comedy hip hop|country rap|dungeon sound|folkhop|
    genge|gengetone|hipco|hiplife|pluggnb|sissy bounce|ambient plugg`,
  "Pop": `
    barbershop|donosti sound|canzone d'autore|chanson à texte|close harmony|contemporary christian|coon song|
    disco polo|electropop|industrial musical|jesus music|musical|neo-acoustic|nyū myūjikku|palingsound|
    parlour music|pop rock|praise & worship|psychedelic pop|rock musical|russian chanson|sitarsploitation|synth-pop|
    tin pan alley|yakousei`,
  "R&B & soul": `
    beach music|hip hop soul|new jack swing|pop soul|porn groove|swamp pop|synth funk|trap soul`,
  "Electronic": `
    acholitronix|alternative dance|aquacrunk|autonomic|bacardi|batida|birmingham sound|black midi|broken beat|club|
    complextro|cyberpunk|dance|deep tech|digital hardcore|doomcore|dreampunk|drill and bass|electro swing|
    festival trap|folktronica|frapcore|freestyle|future bounce|hard trap|heaven trap|hybrid trap|jazz house|
    jazzstep|jump up|lento violento|lo-fi house|melbourne bounce|minimal wave|moogsploitation|nerdcore techno|
    nitzhonot|organic house|phonk house|plunderphonics|power noise|pumpcore|purple sound|raggacore|raggatek|
    rominimal|sambass|sampledelia|seapunk|skweee|sovietwave|suomisaundi|trap edm|twerk|uk jackin|vaportrap|wa euro|
    wave|zenonesque`,
  "Chill & ambient": `
    dungeon chip|hypnagogic pop|spamwave|utopian virtual`,
  "Rock": `
    avant-prog|blues rock|boogie rock|british rhythm & blues|britpop|brutal prog|coldwave|crossover prog|crunkcore|
    dark wave|electronic rock|ethereal wave|funk rock|glam|gothic|group sounds|hamburger schule|hot rod music|
    industrial rock|jangle pop|math pop|neo kyma|neoclassical dark wave|neue deutsche todeskunst|
    neue deutsche welle|new romantic|new wave|noise pop|noisecore|post-britpop|power pop|
    psichedelia occulta italiana|punk blues|rap rock|rautalanka|ska punk|skacore|steampunk|symphonic prog|
    symphonic rock|zolo`,
  "Metal": `
    folk metal|gorenoise|rap metal|rapcore`,
  "Jazz & blues": `
    afro-jazz|ethio-jazz|jazz poetry|jazz rock|modern creative|novelty piano|west coast swing`,
  "Folk & country": `
    bluegrass gospel|fahrtenlied|filk|hornpipe|british folk rock|country boogie|country gospel|country rock|
    folk rock|gaelic psalm singing|gothic country|industrial folk song|psychedelic folk|sacred harp|southern gospel|
    western swing`,
  "Latin": `
    3-step|new mexico music|afro-cuban jazz|bandinha|batucada|bullerengue|cachaca|canto a lo poeta|canto cardenche|
    cantoria|caporal|carranga|chamarrita rioplatense|champeta|chicha|chilena|chimayche|chotis madrileño|chuscada|
    ciranda|coco|copla cajamarquina|currulao|cururu|doble paso|dobrado|electrotango|embolada|fandango|
    fandango caiçara|guarania|guitarrada|huaylarsh|jongo|jota|latin disco|malagueña venezolana|marchinha|merecumbé|
    merequetengue|moda de viola|morenada|movimiento alterado|muliza|pagodão|palo de mayo|pandilla|partido alto|
    pasodoble|payada|pilón|pirekua|polca criolla|polka paraguaya|porro|punto|puxa|rasqueado cuiabano|repente|
    romantic flow|saeta|sanjuanito|saya afroboliviana|seguidilla|sikuri|tamborera|tamborito|taquirari|tiento|
    toada de boi|trapfunk|tropicanibalismo|tumba francesa|udigrudi|xaxado|yaraví`,
  "Reggae & Caribbean": `
    2 tone|bélé|dennery segment|dub poetry|fungi|gospel reggae|haitian vodou drumming|parang|punta|rapso|reggae-pop|
    tassa|trap dancehall`,
  "World": `
    afro rock|afro-funk|bandari|batuque|cante alentejano|coladeira|congolese rumba|desert blues|finnish tango|
    funaná|griot|hungarian folk|kizomba|kuduro|maloya|maloya électronique|maloya élektrik|morna|odissi classical|
    pop raï|séga|séga tambour|seggae|symphonic mugham|tarraxinha|tonada asturiana|township bubblegum|
    traditional séga|trap shaabi|turbo-folk|turkish folk|upopo|vietnamese bolero|wassoulou|aak|abhang|aboio|adhan|
    adhunik geet|afoxê|afrobeat|afrobeats|afropiano|agbadza|agbekor|ahwash|aita|al jeel|aleke|algerian chaabi|
    alloukou|alté|ambasse bey|apala|arabesk|ashkenazi cantorial music|assiko|avanzada|baila|baisha xiyue|
    baithak gana|balani show|balitaw|banga|bantengan|baqashot|batonebi songs|baul gaan|bedoui wahrani|bend-skin|
    benga|beni|benna|beompae|bhajan|bhangra|bhavageethe|bikutsi|biraha|bocet|boduberu|boedra|bogino duu|bongo flava|
    bozlak|burger-highlife|burmese mono|burmese stereo|burrakatha|ca trù|cải lương|čalgija|campursari|
    canto degli alpini|cantu a chiterra|cantu a tenore|chakacha|chalga|chamarrita açoriana|changa tuki|
    changjak gugak|chaozhou xianshi|chazzanut|chèo|chimurenga|chinese literati music|chöd|cilokaq|colindă|
    coupé-décalé|csárdás|dabke|dangak|dangdut|danmono|dechovka|desgarrada|dhaanto|dhol tasha|dhrupad|dikir barat|
    dimotiko|djanba|dohori|doina|dondang sayang|dongjing|dongzu dage|duma|éntekhno|euskal kantagintza berria|fado|
    fado de coimbra|fakaseasea|falak|famo|fantezi|fijiri|filipino rondalla|fon leb|fuji|fusion gugak|gaana|gagaku|
    gagok|gambang kromong|garba|għana|ghazal|ginan|gnawa|gommance|gondang|gstanzl|guangdong yinyue|guayla|gumbe|
    guoyue|hanmai|haozi|harana|harawi|hát tuồng|heikyoku|highlife|himene tarava|honkyoku|hyangak|ʻōteʻa|iavnana|
    iraqi maqam|isa|isicathamiya|islamic modal music|islamic religious music|izlan|izvorna bosanska muzika|jácara|
    jaipongan|jeongak|jhumar|jiangnan sizhu|jibonmukhi gaan|jit|jiuta|jōruri|jùjú|kacapi suling|kadodi|kadongo kamu|
    kafi|kagura|kakawin|kalattut|kalindula|kalon'ny fahiny|kaneka|kantan chamorrita|kanto|kantruem|kapuka|kecak|
    keroncong|kete|ketuk tilu|khrueang sai|khyal|kidandali|kidumbak|kilapanga|kirtan|klapa|klasik|klezmer|kliningan|
    konnakol|koplo|kouta|krakowiak|kuda lumping|kujawiak|kulintang|kumi-daiko|kumiuta|kundiman|kunqu|kwassa kwassa|
    kwela|laiko|langgam jawa|lavani|liscio|liwa|luk thung|maddahi|maftirim|mahori|mahraganat|makossa|malhun|malouf|
    manele|mangambeu|mantra|manyao|mappila|marabi|marrabenta|maskanda|mataali|mbalax|mbaqanga|mbolé|mbube|mchiriku|
    meiji shinkyoku|menzuma|meyxana|mgodro|min'yō|modern laiko|mor lam|mor lam sing|moroccan chaabi|moutya|muak|
    mugham|mugithi|muiñeira|musette|música de intervenção|música festera|mūsīqā lubnāniyya|muzika mizrahit|
    muzika yehudit mekorit|muzikat dika'on|muziki wa dansi|nagara naam|nagauta|nanguan|narodnozabavna glasba|
    nasheed|natya sangeet|néo-trad|nepali lok geet|ngâm thơ|ngoma|nhạc đỏ|nhạc tiền chiến|nigun|njuup|noh|nóta|
    nova cançó|oberek|ogene music|omutibo|ondō|orkes gambus|özgün müzik|paghjella|pala|palm-wine|pansori|pásztordal|
    phleng phuea chiwit|pimba|pinpeat|piphat|piyyut|pizzica|polifonia occitana|powada|pungmul|qaraami|
    qasidah modern|qawwali|quan họ|quyi|rabbit song|rabiz|raï|raqs baladi|rebetiko|red song|rhumba|rigsar|rizitika|
    rōkyoku|rom kbach|runo song|russian romance|sa'idi|salegy|saluang klasik|samri|sanjo|santé engagé|sarala gee|
    sardana|sawt|semba|seto leelo|sevdalinka|shaabi|shabad kirtan|shan'ge|shanto|shashmaqam|shima-uta|shinkyoku|
    shōmyō|shoor|sigidrigi|sinawi|sizhu music|skiladiko|sōkyoku|song of sana’a|soukous|staïfi|stornello|stotra|
    sufiana kalam|sungura|sutartinės|taarab|tajaraste|takamba|talempong|talempong goyang|tallava|tammurriata|
    tân cổ giao duyên|tanjidor|taoist ritual music|tappa|tarana|tarantella|tarawangsa|tassu|tchinkoumé|
    tembang cianjuran|thumri|timbila|tivaner inngernerlu|tizita|township jive|tradi-moderne congolais|
    tradi-moderne ivoirien|trallalero|trikitixa|tsapiky|tsugaru-jamisen|tumba|tumbélé|uaajeerneq|ufie music|unakesa|
    unyago|urtiin duu|urumi melam|uyghur muqam|uzun hava|vaigat|verbunkos|vude|waila|waka|wangga|white voice|
    wong shadow|world fusion|worldbeat|xẩm|xuc|yanyue|yayue|yu-mex|yukar|zema|zemirot|zeybek|ziglibithy|zinli|
    zoblazo|zohioliin duu|zouglou`,
  "Classical": `
    acousmatic|ballad opera|contenance angloise|eai|electroacoustic|futurism|graphical sound|medieval lyric poetry|
    musique concrète|musique concrète instrumentale|reductionism|russian orthodox liturgical music|sound poetry|
    tape music|western classical`,
};
const OVERRIDES = new Map(
  Object.entries(NAMED).flatMap(([family, names]) => names.split("|").map((g) => [g.replace(/\s+/g, " ").trim(), family]))
);

// Checked in order, first match wins, so a name that crosses families ("pop rap", "jazz rap", "trap latino",
// "pop punk") goes to whichever rule comes first.
const RULES = [
  ["Spoken & comedy", String.raw`
    comedy|spoken word|poetry|audio drama|audio documentary|interview|lecture|sermon|^speech$|prank calls|sketch|
    standup|asmr|guided meditation|fairy tale`],
  ["Latin", String.raw`
    latin|reggaeton|cumbia|salsa|bachata|merengue|samba|bossa nova|^mpb$|sertanejo|forró|
    funk (brasileiro|carioca|automotivo|mandelão|ostentação|proibidão|melody|consciente|de bh)|brega|funknejo|
    eletrofunk|tango|\btejano|norteño|corrido|\bbanda\b|mariachi|ranchera|bolero|^son |son cubano|mambo|cha ?cha|
    timba|dembow|perreo|tropicália|axé|pagode|choro|baião|flamenco|bulería|sevillanas|rumba|guaracha|vallenato|
    huayno|bambuco|chacarera|zamba|cueca|nueva canción|nueva trova|trova|tropipop|tecnocumbia|duranguense|grupera|
    regional mexicano|sierreño|huapango|reparto|cubatón|bachatón|piseiro|arrocha|frevo|maracatu|carimbó|lambada|
    mangue beat|tecnobrega|kuduro|neoperreo|rkt|cumbiatón|joropo|pasillo|merenhouse|mulatós|technobanda|tamborzão|
    batidão|beat (bolha|bruxaria|fino)|ritmada|rasteirinha|vanera|xote|jovem guarda|
    música (cebolla|criolla|llanera|típica chilena)|candombe|murga|milonga|chamamé|agronejo|danzón|chachachá|
    son montuno|songo|guajira|guaguancó|bomba|plena|pachanga|charanga|boogaloo|descarga|changüí|conga|habanera|
    filin|onda nueva|vals (criollo|venezolano)|marinera|festejo|landó|tondero|valsa brasileira|samba-|modinha|
    maxixe|lundu|seresta|gaita zuliana|calipso venezolano|nuevo cancionero|neofolklore|baguala|carnavalito|tonada|
    cuarteto|mexican|tex-mex`],
  ["Hip hop", String.raw`
    hip[- ]?hop|\brap$|\brap\b|trap|drill|boom bap|phonk|grime|crunk|plugg|g-funk|dirty south|horrorcore|nerdcore|
    hyphy|chopped and screwed|turntablism|beatboxing|battle record|houston sound|memphis rap|miami bass|jerk|
    ^rage$|digicore|hexd|sigilkore|dungeon rap|mobb music|ratchet music|snap|barber beats`],
  ["Metal", String.raw`
    metal|grind|deathcore|djent|thall|doom|sludge|nwobhm|neue deutsche härte|'n' roll|mathcore|thrash|blackened|
    mincecore|electronicore|nintendocore|swancore|sasscore|crossbreed`],
  ["Jazz & blues", String.raw`
    jazz|blues|bebop|\bbop\b|swing|ragtime|dixieland|big band|^stride$|boogie-woogie|cakewalk|vocalese|
    third stream|conducted improvisation|free improvisation|paramaribop`],
  ["Chill & ambient", String.raw`
    ambient|chill|downtempo|trip hop|new age|lounge|vaporwave|mallsoft|slushwave|eccojams|meditation|psybient|
    illbient|^drone$|easy listening|exotica|space age pop|cocktail nation|kankyō ongaku|binaural beats|sleep|
    balearic beat|hauntology|comfy synth|dungeon synth|winter synth|nature sounds|rain sounds|whale song|birdsong|
    animal sounds|field recording|slowed & reverb`],
  ["Electronic", String.raw`
    house|techno|trance|edm|electro|dubstep|drum and bass|jungle|breakbeat|breaks\b|breakcore|^breaks$|
    garage(?! rock| punk| psych)|\bbass\b|bassline|2-step|step$|halftime|hardstyle|rawstyle|psystyle|dubstyle|
    jumpstyle|gabber|hardcore (techno|breaks)|(happy|uk|freeform|industrial|uptempo|breakbeat) hardcore|hardtek|
    hardtekk|tekno|frenchcore|speedcore|splittercore|terrorcore|extratone|flashcore|j-core|makina|hands up|
    hard nrg|hi-nrg|hardbass|hardbag|idm|glitch|rave|eurodance|eurobeat|disco|future|synthwave|outrun|darksynth|
    dreamwave|spacesynth|chiptune|bitpop|8-bit|bit music|fm synthesis|big beat|footwork|juke|jersey (club|sound)|
    baltimore club|philly club|club|wonky|leftfield|witch house|industrial|ebm|aggrotech|synth|neurofunk|
    liquid funk|drumfunk|microfunk|ghetto funk|funktronica|gqom|amapiano|kwaito|nightcore|moombah|riddim|briddim|
    tearout|colour bass|nu skool|livetronica|indietronica|electronica|electronic|krushclub|bubbling|ghettotech|
    bounce|dariacore|hyper ?techno|hardvapour|hardwave|bytebeat|microsound|lowercase|weightless|deconstructed|
    neurohop|berlin school|algorave|bleep|uk funky|speed garage|tribal guarachero|nortec|shangaan electro|singeli|
    baile|funkot|budots|vinahouse|donk|tecnorumba|tecnomerengue|tecnofunk|lolicore|mashcore|artcore|amigacore|
    acidcore|darkcore|demostyle|nustyle|nu style|stutter|noiadance|flex dance|j-euro|italo|hard beat|hard drum|
    new beat|neo rave|new rave|frenchtek|free car music|schranz|trancestep|mad$|^tbm$|tread|xtra raw|rawphoric|
    powerstomp|psycore|full-on|hi-tech|darkstep|lowend`],
  ["Reggae & Caribbean", String.raw`
    reggae|dancehall|\bska\b|^dub$|dubwise|novo dub|rocksteady|ragga|soca|calypso|mento|zouk|compas|kompa|bouyon|
    cadence|lovers rock|deejay|junkanoo|chutney|steel band|biguine|gwo ka|kasékò|kaseko|méringue|rara|rasin|
    twoubadou|goombay|shatta|spouge|bashment|jawaiian|cabo zouk|kréyol djaz`],
  ["R&B & soul", String.raw`
    r&b|soul|funk|gospel|motown|new jack swing|doo-wop|quiet storm|go-go|boogie|spirituals|ring shout|
    sacred steel|minneapolis sound|uk street soul|jubilee|concert spiritual|praise break`],
  ["Rock", String.raw`
    rock|punk|\bemo\b|emo$|emocore|emoviolence|screamo|hardcore|grunge|shoegaze|blackgaze|shitgaze|krautrock|surf|
    rockabilly|psychobilly|grebo|madchester|^c86$|no wave|riot grrrl|queercore|cuddlecore|^oi$|uk82|d-beat|crust|
    stenchcore|raw punk|powerviolence|burning spirits|post-punk|psych|beat music|freakbeat|merseybeat|mod\b|
    mod revival|jam band|slowcore|sadcore|math rock|zeuhl|canterbury scene|art rock|aor|glam|gothic|deathrock|
    britcore|dunedin sound|paisley underground|nederbeat|eleki|zamrock|post-rock|visual kei|soft visual|loud kei|
    indie surf|easycore|frat|hopepunk|slimepunk|noise rock|pigfuck|indorock`],
  ["Folk & country", String.raw`
    folk|country|americana|bluegrass|jamgrass|honky tonk|old-time|cajun|zydeco|celtic|irish|appalachian|
    sea shanty|skiffle|stomp and holler|red dirt|nashville|western|yodel|cowboy|dansband|dansktop|bakersfield|
    hillbilly|fiddl|hapa haole|slack-key|liedermacher|kleinkunst|avtorskaya|alpenrock|volkstümliche|ländler|polka|
    humppa|hambo|schottische|contra|scottish country|waulking|puirt|sean-nós|pìobaireachd|pipe band|bagad|
    kan ha diskan|joik|jug band|fife and drum|american primitive|trampská|bard|wyrd|minstrelsy|rustic stomp|
    cowpunk|anti-folk|neofolk|bardcore`],
  ["Pop", String.raw`
    pop|schlager|chanson|cabaret|vaudeville|brill building|music hall|teen|idol|enka|kayō|ryūkōka|city pop|
    shibuya-kei|traditional pop|europop|^trot$|semi-trot|korean ballad|latin ballad|estrada|canzone|levenslied|
    nederpop|^opm$|denpa|moe song|akishibu-kei|yé-yé|bubblegum|sunshine|crooner|revue|kabarett|chamber|tontipop|
    picopop|manila sound|operatic|ballad|eurovision|piosenka aktorska|cuplé|copla|canción melódica|
    romanian popcorn|cantopop|mandopop|shidaiqu|gufeng|zhongguo feng|neo-city pop|luk krung|nhạc vàng|v-pop|t-pop|
    q-pop|filmi|bhojpuri|indian pop|persian pop|turkish pop|orthodox pop`],
  ["World", String.raw`
    (beijing|cantonese|chinese|sichuan|henan|yue|yangzhou|korean revolutionary|chinese revolutionary) opera|
    (carnatic|hindustani|indian|persian|turkish|thai|burmese) classical|
    (chinese|korean|japanese|vietnamese|andalusian|southeast asian) classical|
    (tibetan buddhist|vedic|celtic) chant|throat singing|gamelan`],
  ["Classical", String.raw`
    classical|baroque|opera|opéra|oper\b|symphon|concert|sonata|chant|requiem|oratorio|cantata|motet|^mass$|
    madrigal|^lied$|mélodie|art song|minimalism|serialism|impressionism|expressionism|romantic|renaissance|
    medieval|^ars |ballet|zarzuela|operetta|orchestral|orchestra|string quartet|étude|nocturne|prelude|fugue|
    toccata|ricercar|canzona|fantasia|capriccio|bagatelle|impromptu|overture|serenade|symphony|waltz|mazurka|
    polonaise|march|marching|brass band|military|spectralism|new complexity|totalism|integral serialism|
    indeterminacy|stochastic|sonorism|microtonal|neoclassicism|neoromanticism|post-minimalism|process music|
    church music|hymn|psalm|plainchant|troparion|kontakion|sticheron|lute song|troubadour|minnesang|lauda|
    villancico|tragédie|singspiel|zeitoper|verismo|monodrama|passion setting|theme and variations|divertissement|
    character piece|english pastoral|hard renaissance|change ringing|drum and bugle|drumline|pep band|
    concert band|guggenmusik|circus|tonadilla|género (chico|grande)|comédie-ballet|ballet de cour|baroque suite|
    choral|anglican|vocal music|post-classical`],
].map(([family, src]) => [new RegExp(src.replace(/\n\s*/g, "")), family]);

// A MusicBrainz genre's family, or null when it describes a sound rather than a style (see DESCRIPTORS)
export function familyOf(genre) {
  const g = String(genre).toLowerCase().trim();
  if (g in DESCRIPTORS) return null;
  if (OVERRIDES.has(g)) return OVERRIDES.get(g);
  for (const [re, family] of RULES) if (re.test(g)) return family;
  return "Other";
}

// Below this share of an artist's votes, a family is a stray tag rather than part of their sound, so it's dropped
// (one vote for "classical" shouldn't put a slice of Radiohead in Classical)
const MIN_SHARE = 0.1;

// An artist's genres, [[genre, votes], ...], as [[family, weight], ...]: the weights sum to 1, heaviest first.
// Descriptors count only when an artist has nothing else. When no genre has a vote, each counts the same.
export function artistFamilies(genres) {
  if (!genres?.length) return [];
  let tags = genres.map(([g, v]) => [familyOf(g), Math.max(0, Number(v) || 0)]).filter(([f]) => f);
  if (!tags.length) {
    tags = genres
      .map(([g, v]) => [DESCRIPTORS[String(g).toLowerCase().trim()], Math.max(0, Number(v) || 0)])
      .filter(([f]) => f);
  }
  if (!tags.length) return [];
  if (tags.every(([, v]) => v === 0)) tags = tags.map(([f]) => [f, 1]);
  const sums = new Map();
  for (const [f, v] of tags) sums.set(f, (sums.get(f) ?? 0) + v);
  const total = [...sums.values()].reduce((s, v) => s + v, 0);
  const kept = [...sums].sort((a, b) => b[1] - a[1]).filter(([, v], i) => i === 0 || v >= MIN_SHARE * total);
  const keptTotal = kept.reduce((s, [, v]) => s + v, 0);
  return kept.map(([f, v]) => [f, v / keptTotal]);
}
