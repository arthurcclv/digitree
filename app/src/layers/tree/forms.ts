/**
 * Species → silhouette. The table behind the *Form classes* and *The species
 * table* sections of `specs/spec.md`.
 *
 * This module is deliberately free of three.js: it is a pure lookup, which is
 * what makes it the one part of the layer that can be tested without a GL
 * context. The geometry each form resolves to lives in `formGeometry.ts`.
 */

/**
 * The eight silhouettes the layer can draw.
 *
 * Named for shape, never for a taxon — the inventory punishes taxonomic naming.
 * 福木 is a broadleaf that is `columnar`; 竹柏 and 羅漢松 are conifers that are
 * also `columnar` but are neither pine nor cypress; 楓香 is `upright` next to
 * 青楓 without being an *Acer*. A class called `cypress` would have to lie about
 * three of those. Adding or renaming a member here is a spec change.
 */
export type TreeForm =
  | "spreading"
  | "upright"
  | "tiered"
  | "columnar"
  | "conic"
  | "palm-feather"
  | "palm-fan"
  | "generic";

/**
 * The 100 species that carry 95.02% of the 162,930 surveyed trees. The tail is
 * 371 species averaging 22 trees each; classifying it would not change what the
 * map looks like, so it is left to `generic`.
 *
 * Keys are matched exactly — see the spec for why no normalisation step exists.
 * This table is a judgement about what each species looks like, not something
 * derived from the data: a wrong row is a wrong shape on the map and is an
 * error nowhere else.
 */
export const SPECIES_FORMS: Readonly<Record<string, TreeForm>> = {
  // Crown wider than tall — 46.66% of the inventory, led by 榕樹 at 18,695.
  榕樹: "spreading",
  茄苳: "spreading",
  樟樹: "spreading",
  水黃皮: "spreading",
  阿勃勒: "spreading", // contested: vase-shaped as often as domed
  苦楝: "spreading",
  垂榕: "spreading",
  烏桕: "spreading",
  菩提樹: "spreading",
  芒果: "spreading",
  榔榆: "spreading",
  盾柱木: "spreading",
  流蘇: "spreading",
  印度紫檀: "spreading",
  第倫桃: "spreading",
  鳳凰木: "spreading",
  血桐: "spreading",
  黃連木: "spreading",
  梅: "spreading",
  黃脈刺桐: "spreading",
  印度橡膠樹: "spreading",
  水柳: "spreading",
  肯氏蒲桃: "spreading",
  構樹: "spreading",
  豔紫荊: "spreading",
  龍眼: "spreading",
  雀榕: "spreading",
  海檬果: "spreading",
  緬梔花: "spreading",
  青剛櫟: "spreading",
  刺桐: "spreading",
  陰香: "spreading",
  桑樹: "spreading",
  鐵刀木: "spreading",
  洋紫荊: "spreading",
  柚子: "spreading",
  楊桃: "spreading",
  鐵冬青: "spreading",
  紅楠: "spreading",
  山黃麻: "spreading",
  相思樹: "spreading",
  朴樹: "spreading",
  番石榴: "spreading",
  稜果榕: "spreading",

  // Crown taller than wide — 28.27%, led by 楓香 at 10,409.
  楓香: "upright", // contested: conical when young, broadly oval when mature
  臺灣欒樹: "upright",
  白千層: "upright",
  山櫻花: "upright",
  大花紫薇: "upright",
  光蠟樹: "upright",
  紫薇: "upright",
  九芎: "upright",
  櫻花: "upright",
  櫸: "upright",
  鵝掌柴: "upright",
  美人樹: "upright",
  青楓: "upright",
  猢猻木: "upright",
  洋紅風鈴木: "upright",
  火焰木: "upright",
  馬拉巴栗: "upright",
  蓮霧: "upright",
  香楠: "upright",
  無患子: "upright",
  富士櫻: "upright",
  黃金風鈴木: "upright",
  風鈴木: "upright",
  蘭嶼烏心石: "upright",
  烏心石: "upright",
  穗花棋盤腳: "upright",
  大葉桉: "upright",
  錫蘭橄欖: "upright",
  桃花心木: "upright",
  大葉桃花心木: "upright",

  // Horizontal whorled layers with visible gaps — 9.45%. The silhouettes that
  // read as Taipei, which is why they are split out of the broadleaf mass.
  黑板樹: "tiered",
  小葉欖仁: "tiered",
  木棉: "tiered", // contested: most legible bare, which this layer does not model
  欖仁樹: "tiered",
  掌葉蘋婆: "tiered",

  // Narrow, near-vertical sides, foliage to the ground — 4.19%. Three families,
  // one shape: 福木 is a broadleaf, 竹柏 and 羅漢松 are podocarps, 龍柏 and
  // 側柏 are cypresses.
  福木: "columnar",
  龍柏: "columnar",
  蘭嶼羅漢松: "columnar",
  羅漢松: "columnar",
  竹柏: "columnar",
  側柏: "columnar",
  白玉蘭: "columnar",
  厚皮香: "columnar",
  大葉山欖: "columnar",
  桂花: "columnar",

  // Tapering spire — 1.52%.
  落羽杉: "conic",
  小葉南洋杉: "conic",
  肯氏南洋杉: "conic",
  溼地松: "conic",
  杜英: "conic",

  // Bare trunk, pinnate crown — 3.72%.
  大王椰子: "palm-feather",
  黃椰子: "palm-feather",
  羅比親王海棗: "palm-feather",
  亞力山大椰子: "palm-feather",

  // Bare trunk, palmate crown — 1.21%.
  蒲葵: "palm-fan",
  華盛頓椰子: "palm-fan",
};

/**
 * The form a tree draws in.
 *
 * Everything the table does not name draws `generic` — an unclassified city
 * species, a custom drop-in's own spelling, and the 18 surveyed rows that carry
 * no species at all. The layer cannot tell a typo from a species nobody has
 * classified yet, so it does not pretend to: there is no warning and no
 * guessing from a neighbour, a substring or a genus.
 */
export function formOf(species: unknown): TreeForm {
  return typeof species === "string" ? (SPECIES_FORMS[species] ?? "generic") : "generic";
}
