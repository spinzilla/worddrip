// 079 词汇量测试用的「假词」：拼写像英语、但并不存在。词表由我们自己编，没抄任何题库。
// 编完用 ECDICT 全量词典（约 77 万词条）和内置词表逐个查过，都查不到；test-vocab-level-test.mjs 会再用内置词表的查词规则（含变形）复核。
// 以后往里加词也要先查过。
export const FAKE_WORDS: readonly string[] = [
  "blorent", "framity", "stendric", "provelent", "crandish", "mordulate", "quistrel", "flenbrook",
  "trabine", "sondrel", "glimmerant", "pelurate", "vantisk", "corbelin", "hestrad", "nulbert",
  "ardegon", "plimsoft", "thrandle", "wexilate", "dobrane", "carminth", "fostrel", "yantric",
  "brolund", "quenate", "sphalder", "morvique", "tenlace", "gurnish", "plasmore", "oblivane",
  "krestle", "drumbel", "falstine", "hovender", "jarvish", "lumbrate", "mentrick", "norvane",
  "opsimate", "perrible", "quillate", "rendrick", "salvane", "tormique", "ulbrate", "vestrane",
  "wintrel", "zandrick", "ambrelle", "bressant", "dentrify", "eskrine", "fenlow", "gramble",
  "harnette", "jolbert", "kervane", "lestrik", "marduin", "nestrum", "ostrand", "pindle",
  "quarmine", "ralvent", "stomber", "trevalle", "vondrel", "wrenlock", "yestrik", "zolbrane",
  "cantrel", "dosmire", "elbrane", "galtrick", "hembrow", "ilverne", "kolbrane", "lanthrop",
  "misterne", "nobrick", "ordrane", "pertrude", "rastrel", "sembrine", "trulane", "urbrand",
  "velkrin", "wolmane", "xenbrane", "yarltine", "zenthrop",
];
