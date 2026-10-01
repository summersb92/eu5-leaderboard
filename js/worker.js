/* EU5 leaderboard - save processing, run in a Web Worker.
   A port of eu5_leaderboard.py: reads a debug-mode (plaintext) .eu5 save
   straight from the File the user picked, and - when the user has linked
   their EU5 install - renders coats of arms and the political map from the
   game's own files. Nothing is uploaded anywhere.

   in:  {save: File, game: GameSource|null, opts: {flags, map, top}}
   out: {type:"log"|"stage"|"done"|"error", ...}                        */
"use strict";
importScripts("dds.js");

const log = (msg) => postMessage({ type: "log", msg });
const stage = (msg) => postMessage({ type: "stage", msg });
/* overall build progress, 0..1 */
const progress = (value) => postMessage({ type: "progress", value });

// --------------------------------------------------------------------------
// tag -> display name. Best-effort, hand-checked; anything missing shows the
// raw tag.
// --------------------------------------------------------------------------
const NAMES = {
  FRA: "France", ENG: "England", GBR: "Great Britain", CAS: "Castile",
  ARA: "Aragon", SPA: "Spain", POR: "Portugal", MOS: "Muscovy",
  RUS: "Russia", NOV: "Novgorod", POL: "Poland", LIT: "Lithuania",
  PLC: "Poland-Lithuania", TEU: "Teutonic Order", LIV: "Livonian Order",
  HUN: "Hungary", BOH: "Bohemia", AUS: "Austria", HAB: "Habsburg",
  BAV: "Bavaria", BRA: "Brandenburg", PRU: "Prussia", SAX: "Saxony",
  SWE: "Sweden", DAN: "Denmark", NOR: "Norway", KAL: "Kalmar Union",
  SCO: "Scotland", IRE: "Ireland", NED: "Netherlands", BUR: "Burgundy",
  FLA: "Flanders", BRB: "Brabant", HOL: "Holland", MIL: "Milan",
  VEN: "Venice", GEN: "Genoa", FLO: "Florence", TUS: "Tuscany",
  PAP: "the Papal State", NAP: "Naples", SIC: "Sicily", SAV: "Savoy",
  BYZ: "Byzantium", OTT: "the Ottomans", TUR: "the Ottomans",
  MAM: "the Mamluks", TUN: "Tunis", MOR: "Morocco", TLC: "Tlemcen",
  TRP: "Tripoli", GRA: "Granada", SER: "Serbia", BUL: "Bulgaria",
  BOS: "Bosnia", CRO: "Croatia", WAL: "Wallachia", MOL: "Moldavia",
  ALB: "Albania", ATH: "Athens", EPI: "Epirus", TRE: "Trebizond",
  GLH: "the Golden Horde", CRI: "Crimea", KAZ: "Kazan", NOG: "Nogai",
  TIM: "the Timurids", PER: "Persia", QAR: "Qara Qoyunlu",
  AKK: "Aq Qoyunlu", JAL: "the Jalayirids", GEO: "Georgia",
  ARM: "Armenia", CYP: "Cyprus", HSA: "the Hansa", LUB: "Lubeck",
  SWI: "Switzerland", COL: "Cologne", MAI: "Mainz", TRI: "Trier",
  PAL: "the Palatinate", WUR: "Wurttemberg", HES: "Hesse",
  MEC: "Mecklenburg", POM: "Pomerania", SIL: "Silesia",
  DLH: "Delhi", BAH: "the Bahmanis", VIJ: "Vijayanagar",
  BEN: "Bengal", GUJ: "Gujarat", CHI: "China", ORI: "Orissa",
  KHM: "the Khmer", DAI: "Dai Viet", MAJ: "Majapahit", PEG: "Pegu",
  CHG: "Chagatai",
  JAP: "Japan", KOR: "Korea", ETH: "Ethiopia", MAL: "Mali",
  SON: "Songhai", KON: "Kongo", AZT: "the Aztecs", INC: "the Inca",
  MYA: "the Maya", ICE: "Iceland", FIN: "Finland", PSK: "Pskov",
  TVE: "Tver", RYA: "Ryazan", SMO: "Smolensk", KIE: "Kiev",
  ULM: "Ulm", NUR: "Nuremberg", AUG: "Augsburg", FRN: "Franconia",
  ANS: "Ansbach", BAD: "Baden", LOR: "Lorraine", PRO: "Provence",
  BRI: "Brittany", ORL: "Orleans", BOU: "Bourbonnais",
  NAV: "Navarra", LEO: "Leon", GAL: "Galicia", VAL: "Valencia",
};

// Fixed-point divisor for country script variables.
const VAR_SCALE = 100000.0;

// Age-of-traditions advances a country starts with when their
// starting_technology_level is at or below its own (1.3.11 values; the
// game's files replace this when an install is linked).
const STARTING_ADVANCES = {
  written_alphabet: 2, cultural_traditions_law_advance: 2, cultural_acceptance_advance: 3,
  codified_laws: 2, agriculture_advance: 1, alchemy_advance: 3, ranching: 1,
  horse_riding_advance: 1, trade_caravans: 1, mining_advance: 1, mining_law_advance: 1,
  iron_working: 1, ship_building_advance: 2, trade_advance_age_of_trad: 3,
  more_merchants_age_of_trad: 3, organized_religion: 4, castle_advance: 3,
  unlock_traditional_galley_advance: 2, unlock_cog_advance: 3, nomadic_tendencies: 4,
  three_sisters: 1, medicinal_infusions: 2, system_of_tributaries: 4, valley_irrigation: 4,
};

/* Every advance in the game files: {ages: [age ids], adv: {name: [age index,
   research_cost, institution it hangs from or "", starting_technology_level
   or 0]}}. An advance hangs from an institution when it, or one it requires,
   is only allowed once that institution is embraced. Takes the files' text. */
function advanceTable(texts) {
  const AGES = ["age_1_traditions", "age_2_renaissance", "age_3_discovery", "age_4_reformation",
    "age_5_absolutism", "age_6_revolutions"];
  const def = new Map();
  for (const txt of texts) {
    const clean = txt.replace(/#[^\n]*/g, "");
    for (const m of clean.matchAll(/^(\w+)\s*=\s*\{([\s\S]*?)^\}/gm)) {
      const b = m[2];
      const age = AGES.indexOf((b.match(/^\s*age\s*=\s*(\w+)/m) || [])[1]);
      if (age < 0) continue;
      const allow = b;
      def.set(m[1], {
        age,
        cost: parseFloat((b.match(/^\s*research_cost\s*=\s*(-?[\d.]+)/m) || [0, 0])[1]) || 0,
        req: [...b.matchAll(/^\s*requires\s*=\s*(\w+)/gm)].map((x) => x[1]),
        inst: (allow.match(/has_embraced_institution\s*=\s*institution:(\w+)/) || [])[1] || "",
        start: parseInt((b.match(/^\s*starting_technology_level\s*=\s*(\d+)/m) || [0, 0])[1], 10) || 0,
      });
    }
  }
  const root = new Map();
  const instOf = (k, seen = new Set()) => {
    if (root.has(k)) return root.get(k);
    const d = def.get(k);
    if (!d || seen.has(k)) return "";
    seen.add(k);
    let r = d.inst;
    for (const q of d.req) { if (r) break; r = instOf(q, seen); }
    root.set(k, r);
    return r;
  };
  const adv = {};
  for (const [k, d] of def) adv[k] = [d.age, d.cost, instOf(k), d.start];
  return { ages: AGES, adv };
}

async function loadAdvanceTable(fs) {
  const dir = "in_game/common/advances";
  const names = await fs.list(dir);
  if (!names) return null;
  const texts = [];
  for (const fn of pySort(names)) if (fn.endsWith(".txt")) texts.push((await fs.text(dir + "/" + fn)) || "");
  const t = advanceTable(texts);
  return Object.keys(t.adv).length ? t : null;
}

/* Research an advance costs: the game's base cost, raised 15% an age, times
   (1 + the advance's research_cost). An estimate: the base is reset when the
   game loads its advances, and advances of an earlier age cost less. */
const RESEARCH_BASE = 25, RESEARCH_AGE_STEP = 0.15;
const advanceCost = (age, add) => RESEARCH_BASE * Math.pow(1 + RESEARCH_AGE_STEP, age) * Math.max(0, 1 + add);

/* Per country: advances gained since the game started (researched, less
   the ones it started with), per age and per institution, and the research
   they cost. */
function attachAdvanceStats(rows, table) {
  for (const r of rows) {
    const done = r._researched, level = r._startLevel;
    if (!done || !table) continue;
    const byAge = [0, 0, 0, 0, 0, 0], byInst = {}, costInst = {};
    let paid = 0;
    for (const a of done) {
      const d = table.adv[a];
      if (!d) continue;
      if (d[0] === 0 && d[3] && level != null && d[3] <= level) continue;
      byAge[d[0]]++;
      const c = advanceCost(d[0], d[1]);
      paid += c;
      if (d[2]) { byInst[d[2]] = (byInst[d[2]] || 0) + 1; costInst[d[2]] = (costInst[d[2]] || 0) + c; }
    }
    for (const k of Object.keys(costInst)) costInst[k] = Math.round(costInst[k]);
    Object.assign(r, { adv_by_age: byAge, adv_by_inst: byInst, research_by_inst: costInst, research_paid: Math.round(paid) });
  }
}

async function loadStartingAdvances(fs) {
  const dir = "in_game/common/advances";
  const names = await fs.list(dir);
  if (!names) return null;
  const out = {};
  for (const fn of pySort(names)) {
    if (!fn.endsWith(".txt")) continue;
    const txt = await fs.text(dir + "/" + fn);
    if (txt == null) continue;
    const clean = txt.replace(/#[^\n]*/g, "");
    for (const m of clean.matchAll(/^(\w+)\s*=\s*\{([\s\S]*?)^\}/gm)) {
      if (!/\bage\s*=\s*age_1_traditions\b/.test(m[2])) continue;
      const s = m[2].match(/\bstarting_technology_level\s*=\s*(\d+)/);
      if (s) out[m[1]] = parseInt(s[1], 10);
    }
  }
  return Object.keys(out).length ? out : null;
}

// Discipline, levy combat ability and military tactics aren't in the save -
// the game derives them from modifiers at run time. The estimate adds up the
// bonuses from sources the save does record, using this table of what each
// source gives (d = discipline, l = levy combat ability, as fractions;
// t = military tactics, on top of the base 1; li, hi, lc, hc, art, aux =
// combat power of light/heavy infantry, light/heavy cavalry, artillery and
// support units, as fractions). Built from the 1.3.11 game
// files by tools/extract_military_modifiers.py.
const MIL_SOURCES = {"advance":{"line_infantry":{"t":0.25},"pike_square":{"t":0.25},"spanish_square":{"t":0.25},"gunpowder_advance":{"t":0.25},"military_tactics_advance_6":{"t":0.25},"feudalism_advance":{"t":1.0},"appointed_chain_of_command":{"l":0.1},"finest_of_horses":{"lc":0.1,"hc":0.1},"regular_levy_training":{"l":0.1},"discipline_drills":{"d":0.05},"superior_firepower":{"art":0.1},"private_to_marshal":{"hi":0.1},"massed_battery":{"art":0.1},"seljuk_roots":{"d":0.05},"ara_gunpowder_souls":{"art":0.1},"bul_the_bulgarian_gunpowder_foundries":{"art":0.1},"bul_the_standing_drilled_infantry":{"d":0.05},"reform_the_feudal_army":{"d":0.05},"compagnie_d_ordonnance":{"hc":0.05},"chg_chagatai_riders":{"lc":0.2},"cri_genghisid_legacy":{"lc":0.2},"dan_royal_life_guards":{"hi":0.1},"english_tradition":{"hi":0.1},"a_modern_nation":{"hi":0.1},"fra_gendarmes":{"hc":0.1},"french_ambition":{"d":0.05},"glh_tatar_traditions":{"lc":0.2},"austrian_military_flexibility":{"t":0.1},"military_border":{"d":0.03},"imperial_artillery":{"art":0.1},"hin_sepahi":{"hi":0.15},"hin_rocketry":{"art":0.1},"hun_composite_light_cavalry":{"lc":0.2},"ilk_descendants_of_genghis_khan":{"lc":0.2},"drafted_hatun_runas":{"l":0.1},"adapted_incan_army":{"t":0.1},"ira_persian_horses":{"lc":0.1},"ira_the_qurchi":{"d":0.05},"karamanid_cavalry":{"lc":0.1},"a_neverending_crusade":{"d":0.05},"kon_study_european_firearms":{"hi":0.05},"kor_border_defense_council":{"hi":0.1},"kor_korean_cannon":{"art":0.1},"krs_kurdish_horses":{"lc":0.15},"mandinka_warrior_spirit":{"d":0.05},"kele_koun_advance":{"li":0.1},"farari_corps_advance":{"lc":0.05},"mge_ghostly_horses_of_the_plain":{"lc":0.2},"preobrazhensky_semyonovsky_imperial_guard":{"t":0.1},"nav_basque_ferocity":{"d":0.025},"nav_riflemen_march":{"hi":0.1},"gel_warring_spirit":{"hi":0.1},"por_battle_ourique":{"li":0.1,"hi":0.1},"por_royal_military_academy":{"art":0.1},"rom_restore_the_legions":{"d":0.025,"hi":0.1},"home_of_hussars":{"lc":0.1},"hum_the_kosaca_iron_fist":{"d":0.05},"military_modernization":{"li":0.1,"hi":0.1},"armories_of_smolensk":{"art":0.1},"malian_military_tactics":{"hi":0.1},"modernization_of_the_military":{"d":0.05},"swedish_tradition":{"hi":0.2},"swedish_steel":{"d":0.05},"teu_crusader_discipline":{"d":0.05},"teu_teutonic_heavy_cavalry":{"hc":0.1},"teu_infantry_tactics":{"hi":0.1},"tamerlane_chess":{"t":0.1},"conquerors_legacy":{"d":0.05},"aztec_chargers":{"hi":0.2},"turkic_traditions":{"d":0.05},"vij_arab_horses":{"lc":0.1},"vij_first_indian_artillery":{"art":0.1},"ayu_prestigious_cavalry":{"hc":0.15},"bos_kingly_ambitions":{"hi":0.05},"cir_horsemen_of_the_steppe":{"lc":0.05},"cro_reliance_on_adriatic":{"li":0.1},"croatian_the_cravats":{"lc":0.15},"svn_the_slavonian_grenadier_regiments":{"d":0.05},"geo_legacy_of_saint_george":{"hi":0.1},"royal_mamluks":{"d":0.05},"study_foreign_gunpowder_techniques":{"art":0.05},"ori_odia_militarization":{"d":0.05},"goose_step":{"li":0.1,"hi":0.2},"auftragstaktik":{"d":0.05},"sia_thai_unity":{"d":0.05},"bavarian_imperial_knights":{"hc":0.1},"bavarian_hofkriegsrat":{"t":0.1},"zmw_discipline_and_traning":{"d":0.05},"zmw_empowering_the_rozwi":{"hi":0.1},"zmw_cow_horn_tactics":{"t":0.1},"albanian_the_stradioti_tradition":{"lc":0.15},"thp_a_centralized_levy_system":{"l":0.1},"ant_the_eternal_resistance":{"d":0.05},"bng_bengali_paik":{"li":0.1},"bng_artillery_corps":{"art":0.1},"cor_guardia_corsa":{"li":0.1},"dal_the_soldato_dalmantine":{"d":0.05},"pcz_piacentine_soldiery":{"d":0.05},"mod_accademia_militare":{"d":0.05},"arabian_horsemanship":{"lc":0.1},"greek_group_stratioti_levies_advance":{"lc":0.1},"ths_thessalian_horse_breeding_advance":{"hc":0.1},"gre_the_new_stratikon_advance":{"li":0.1,"hi":0.1},"feo_the_gothic_red_guard_advance":{"d":0.05},"rhaetian_the_mountain_warriors":{"hi":0.1},"aqu_friulian_soldiery":{"d":0.05},"wallachian_heritage":{"d":0.05},"rmn_the_pandur_militias":{"li":0.1},"haudenosaunee_heritage":{"li":0.1},"warriors_unity":{"d":0.05},"swiss_halberd_infantry":{"hi":0.1},"alpine_defensiveness":{"t":0.1},"advanced_paik_system_advance":{"li":0.05},"jap_bushido":{"d":0.05},"mounted_people":{"lc":0.2,"hc":0.1},"bah_arabian_horses":{"lc":0.1},"lowered_power_of_barons":{"hi":0.1},"mhr_tradition_of_military_service":{"lc":0.15},"pea_the_griffin_companies":{"d":0.05},"neapolitan_army_reforms":{"li":0.1,"hi":0.1},"pie_ordinanza_piedmontese":{"d":0.05},"pie_cavalleria_piemontese":{"t":0.1},"pun_reforming_the_punjabi_army":{"d":0.05},"raj_combat_training":{"hi":0.1},"raj_marwari_horses":{"lc":0.15},"raj_mandatory_firearm_drilling":{"d":0.05},"urb_the_hill_fortresses":{"t":0.1},"rav_battle_of_ravenna":{"d":0.05},"russian_artillery_yard":{"art":0.1},"sar_the_cavalcadores":{"lc":0.15},"cli_the_windic_march_arsenal":{"d":0.05},"toi_muay":{"li":0.1},"pis_natural_philosophy":{"d":0.05,"t":0.1},"perpetual_general_captain_of_the_people":{"t":0.1},"dai_giao_chi_arquebus":{"hi":0.1},"vivaro_alpine_infantry":{"t":0.1,"li":0.1},"cossacks_recruitment":{"lc":0.15},"cossack_administration":{"d":0.05},"cossack_reputation":{"lc":0.1},"ath_the_catalan_company_advance":{"li":0.1,"hi":0.1},"ach_knights_of_the_peloponnese_advance":{"hc":0.1},"lat_the_new_praetorian_guard_advance":{"d":0.05},"the_the_lombard_guard_advance":{"hi":0.1},"neo_the_neopatras_horse_breeding_program_advance":{"hc":0.1},"ath_the_attican_gunpowder_mills_advance":{"art":0.1},"bod_the_oeta_riflemen_advance":{"li":0.05},"trampling_horde":{"lc":0.1},"horde_ardor":{"hc":0.2},"by_the_grace_of_god":{"t":0.025},"cba_katori_jingu":{"hi":0.05},"smz_satsuma_shugo":{"hi":0.1},"stk_kashima_jingu":{"hi":0.1},"tkd_takeda_ryu":{"hc":0.1},"utn_legacy_of_nasu_no_yoichi":{"hi":0.1},"ogs_kiso_uma":{"hc":0.05},"smz_tsurinobuse":{"d":0.05},"dte_dragon_of_oshu":{"hi":0.1},"oda_triple_firing":{"hi":0.1},"smz_tanegashima":{"hi":0.1},"stickball_game":{"li":0.1},"head_hunters":{"li":0.1},"skilled_cavalry_raids":{"lc":0.1}},"policy":{"peasant_levies":[{"l":-0.1}],"longbow_competitions":[{"l":0.1}],"landholders":[{"l":0.05}],"citizenry":[{"l":0.05}],"military_rulership_policy":[{"l":0.2}],"komnenian_formalization":[{"hc":0.1}],"plc_sarmatism":[{"lc":0.1}],"mongol_law_policy":[{"lc":0.1}],"black_army_policy":[{"d":0.025}],"mansabdar_system":[{"hc":0.1}],"elite_training_policy":[{"d":0.05}],"byz_tagmata_policy_upgraded":[{"d":0.025}],"meritocratic_leadership_policy":[{"t":0.1}],"noble_cadets_policy":[{"t":0.1}],"superior_firepower_policy":[{"art":0.1}],"sustained_discipline_policy":[{"li":0.1,"hi":0.1}],"cavalry_warfare_policy":[{"lc":0.1,"hc":0.1}],"al_mamalik_al_sultaniyya":[{"d":0.025}],"sump_law_warrior_culture":[{"d":0.05}],"apc_senapati_focus_policy":[{"d":0.05}],"mall_akhara":[{"hi":0.05}],"miri_piri":[{"d":0.025}]},"privilege":{"clergy_military_orders":[{"d":0.025,"not_reform":"military_order_reform"},{"d":0.05,"reform":"military_order_reform"}],"cossacks_register":[{"t":0.1}],"plc_cossack_treaty_of_hadiach":[{"lc":0.1}],"auxilium_et_consilium":[{"l":0.1}],"primacy_of_nobility":[{"d":0.05}],"rajput_society":[{"d":0.05}],"peasants_allowed_weapons_privilege":[{"l":0.1}],"land_owning_farmers":[{"l":0.05}]},"reform":{"weapons_quality_standards":[{"d":0.05}],"magna_carta_reform":[{"l":0.1}],"basic_timariot_system":[{"lc":0.1}],"expanded_timariot_system":[{"lc":0.2}],"sekban_system":[{"li":0.1}],"ottoman_new_order_army":[{"t":0.1,"art":0.15}],"european_militia_reform":[{"t":0.1,"hc":0.1,"art":0.1}],"modern_imperial_army":[{"d":0.05}],"diwan_i_bandagan":[{"d":0.025}],"cossacks_reform":[{"lc":0.1}],"noble_elite":[{"l":0.05}],"military_order_reform":[{"l":0.1}]},"societal":{"aristocracy_vs_plutocracy":{"left":{"d":0.1}},"serfdom_vs_free_subjects":{"right":{"l":0.1}},"quality_vs_quantity":{"left":{"t":0.1}}},"modifier":{"yua_troop_rotation":{"li":-0.1},"chi_huolongjing":{"art":0.1},"bad_discipline":{"d":-0.05},"nap_struggle_for_independence":{"d":0.1},"blue_dragon":{"lc":0.1},"the_rule_of_god":{"d":0.05},"the_dying_of_the_light":{"d":-0.05},"finest_infantry":{"li":0.05,"hi":0.05},"cavalry_companions":{"lc":0.05,"hc":0.05},"to_the_last_man":{"t":0.1},"good_discipline":{"d":0.025},"overconfidence":{"t":-0.2},"foreign_veterans":{"d":-0.015,"t":0.2},"fra_traditional_warfare":{"hi":0.1},"fra_compagnie_d_ordonnance":{"d":0.05},"fra_belligerent_policy":{"d":0.005},"indochina_french_advisors":{"d":0.05},"fra_favoring_offense_over_vauban_defense":{"t":0.1},"sbl_english_backing":{"l":0.1},"sco_desertion_among_balliol":{"d":-0.1},"sco_advance_into_england":{"d":0.05},"sco_purging_enclaves":{"hi":0.1},"sco_traditional_warfare_preferred":{"hi":0.15},"sco_army_focus":{"d":0.05},"sco_focus_on_exterior_enemies":{"hi":0.1},"battle_artillery_model":{"art":0.15},"artillery_advantage":{"art":0.1},"jap_tadayoshi_arrival_to_stc":{"hi":0.15},"jap_shogunal_army":{"hi":0.1},"jap_shogunal_army_levy_focus":{"li":0.05},"plc_school_of_chivalry_burghers_modifier":{"d":0.05},"plc_school_of_chivalry_modifier":{"d":0.05},"ira_selective_horse_breeding":{"lc":0.2},"ottoman_artillery_reform":{"art":0.1},"aristocracy_united":{"d":0.05},"iro_strong_tribal_unity":{"li":0.2},"iro_champlain_aided_the_hurons":{"li":0.1},"trading_in_firearms_iro":{"hi":0.15},"nov_study_of_gunpowder":{"hi":0.05},"maj_sumpah_palapa_modifier":{"d":0.05},"quality_arms_modifier":{"d":0.03},"parl_feudal_levies_mod":{"hc":0.05},"parl_cavalry_reserve_mod":{"l":0.1},"equus_october_modifier":{"hc":0.2},"gymnopaedia_modifier":{"d":0.05},"disciplined_service_modifier":{"d":0.1},"reformation_of_the_infantry_modifier":{"li":0.05,"hi":0.05},"reformation_of_the_cavalry_modifier":{"lc":0.05,"hc":0.05},"byz_renewed_military_modifier":{"d":0.01},"legendary_generals_modifier":{"d":0.05},"strategikon_pezikou_modifier":{"hi":0.05},"strategikon_ippikou_modifier":{"hc":0.05}},"trait":{"tactical_genius":{"t":0.05},"strict":{"d":0.05}}};

// Each army unit type's [combat power, damage done x, damage taken x, category],
// after copy_from; damage done/taken average the strength and morale
// modifiers of the unit and its category. From the 1.3.11 game files by
// `tools/extract_military_modifiers.py --units`.
const UNIT_STATS = {"a_age_1_traditions_light_infantry":[1.0,0.95,1.05,"li"],"a_age_1_traditions_heavy_infantry":[1.0,1.0,1.0,"hi"],"a_age_1_traditions_light_cavalry":[4.0,0.95,0.788,"lc"],"a_age_1_traditions_heavy_cavalry":[4.0,1.0,0.75,"hc"],"a_age_1_traditions_auxiliary":[0.25,1.0,1.25,"aux"],"a_age_1_traditions_artillery":[2.0,1.0,1.25,"art"],"a_age_2_renaissance_light_infantry":[1.0,0.95,1.05,"li"],"a_age_2_renaissance_heavy_infantry":[1.0,1.0,1.0,"hi"],"a_age_2_renaissance_light_cavalry":[4.0,0.95,0.788,"lc"],"a_age_2_renaissance_heavy_cavalry":[4.0,1.0,0.75,"hc"],"a_age_2_renaissance_auxiliary":[0.25,1.0,1.25,"aux"],"a_age_2_renaissance_artillery":[3.0,1.0,1.25,"art"],"a_age_3_discovery_light_infantry":[1.0,0.95,1.05,"li"],"a_age_3_discovery_heavy_infantry":[1.0,1.0,1.0,"hi"],"a_age_3_discovery_light_cavalry":[4.0,0.95,0.788,"lc"],"a_age_3_discovery_heavy_cavalry":[4.0,1.0,0.75,"hc"],"a_age_3_discovery_auxiliary":[0.25,1.0,1.25,"aux"],"a_age_3_discovery_artillery":[4.0,1.0,1.25,"art"],"a_age_4_reformation_light_infantry":[1.5,0.95,1.05,"li"],"a_age_4_reformation_heavy_infantry":[1.5,1.0,1.0,"hi"],"a_age_4_reformation_light_cavalry":[4.0,0.95,0.788,"lc"],"a_age_4_reformation_heavy_cavalry":[4.0,1.0,0.75,"hc"],"a_age_4_reformation_auxiliary":[0.25,1.0,1.25,"aux"],"a_age_4_reformation_artillery":[5.0,1.0,1.25,"art"],"a_age_5_absolutism_light_infantry":[2.25,0.95,1.05,"li"],"a_age_5_absolutism_heavy_infantry":[2.25,1.0,1.0,"hi"],"a_age_5_absolutism_light_cavalry":[4.0,0.95,0.788,"lc"],"a_age_5_absolutism_heavy_cavalry":[4.0,1.0,0.75,"hc"],"a_age_5_absolutism_auxiliary":[0.25,1.0,1.25,"aux"],"a_age_5_absolutism_artillery":[5.5,1.0,1.25,"art"],"a_age_6_revolutions_light_infantry":[3.0,0.95,1.05,"li"],"a_age_6_revolutions_heavy_infantry":[3.0,1.0,1.0,"hi"],"a_age_6_revolutions_light_cavalry":[4.0,0.95,0.788,"lc"],"a_age_6_revolutions_heavy_cavalry":[4.0,1.0,0.75,"hc"],"a_age_6_revolutions_auxiliary":[0.25,1.0,1.25,"aux"],"a_age_6_revolutions_artillery":[7.5,1.0,1.25,"art"],"a_gendarmerie":[4.0,1.0,0.562,"hc"],"a_provincial_cavalry":[4.0,1.0,0.562,"hc"],"a_late_cavaliers":[4.0,1.0,0.562,"hc"],"a_cavaliers":[4.0,1.0,0.562,"hc"],"a_plated_knights":[4.0,1.0,0.469,"hc"],"a_teulu":[4.0,1.0,0.656,"hc"],"a_mailed_knights":[4.0,1.0,0.562,"hc"],"a_noble_cavalry":[4.0,1.0,0.619,"hc"],"a_order_knights":[4.0,1.0,0.562,"hc"],"a_order_knights_2":[4.0,1.0,0.562,"hc"],"a_moa_hunters":[1.0,0.95,1.05,"li"],"a_tribesmen":[1.0,0.95,1.05,"li"],"a_warriors":[1.0,1.0,1.0,"hi"],"a_champions":[1.0,1.0,1.0,"hi"],"a_chieftains":[1.0,1.0,1.0,"hi"],"a_villagers":[1.0,0.95,1.25,"li"],"a_feudal_levy":[1.0,0.9,1.05,"li"],"a_crusader_knights_base":[1.0,1.0,0.95,"hi"],"a_crusader_knights_levy":[1.0,1.0,0.95,"hi"],"a_crusader_knights":[1.0,1.0,0.95,"hi"],"a_caterans":[1.0,0.95,1.05,"li"],"a_kerns":[1.0,0.95,1.05,"li"],"a_lour_lances":[1.0,0.95,1.05,"li"],"a_schiltron":[1.0,0.95,1.05,"li"],"a_steppe_horse_archers":[4.0,1.05,0.788,"lc"],"a_steppe_horde":[4.0,0.95,0.788,"lc"],"a_tribal_cavalry":[4.0,0.95,0.788,"lc"],"a_a_urughs":[0.25,1.0,1.25,"aux"],"a_almogavars":[1.0,1.0,1.05,"li"],"a_catalan_crossbowmen":[1.0,0.95,1.05,"li"],"a_early_longbowmen":[1.0,0.95,1.05,"li"],"a_hobelars":[4.0,0.95,0.788,"lc"],"a_gallowglass":[1.0,1.0,0.925,"hi"],"a_light_jurchen_cavalry":[4.0,0.95,0.788,"lc"],"a_iron_pagoda_cavalry":[4.0,1.1,0.75,"hc"],"a_early_paik":[1.0,0.9,1.05,"li"],"a_early_paik_infantry":[1.0,0.95,1.0,"li"],"a_byzantine_cataphracts":[4.0,1.165,0.656,"hc"],"a_akritai":[1.0,1.0,0.95,"hi"],"a_varangians":[1.0,1.2,1.0,"hi"],"a_mamluk_unit_traditions":[1.0,1.05,1.0,"hi"],"a_mamluk_horsemen_traditions":[4.0,1.05,0.75,"hc"],"a_halqah_unit":[0.25,1.0,1.25,"aux"],"a_jonow_auxiliary":[0.25,1.0,1.125,"aux"],"a_sofa_infantry":[1.0,0.95,1.05,"li"],"a_mandekalu_infantry":[1.0,0.95,1.05,"li"],"a_mandekalu_cavalry":[4.0,1.0,0.694,"hc"],"a_farari_infantry":[1.0,0.95,1.025,"li"],"a_farari_cavalry":[4.0,1.0,0.619,"hc"],"a_clan_retainers":[1.0,1.0,1.0,"hi"],"a_clan_retainer_cavalry":[4.0,1.0,0.75,"hc"],"a_longbowmen":[1.0,1.0,1.05,"li"],"a_reformed_gallowglass":[1.0,1.0,0.925,"hi"],"a_wagenburg":[1.0,1.0,0.9,"hi"],"a_genoese_crossbowmen":[1.0,0.95,1.05,"li"],"a_late_almogavars":[1.0,1.05,1.05,"li"],"a_late_crusader_knights_base":[1.0,1.0,0.95,"hi"],"a_late_crusader_knights":[1.0,1.0,0.95,"hi"],"a_late_crusader_knights_levy":[1.0,1.0,0.95,"hi"],"a_hwacha":[3.0,1.1,1.25,"art"],"a_mamluk_unit_renaissance":[1.0,1.05,1.0,"hi"],"a_mamluk_horsemen_renaissance":[4.0,1.05,0.75,"hc"],"a_serbian_hussars":[4.0,0.975,0.788,"lc"],"a_muslim_riders_vijay":[4.0,1.05,0.675,"hc"],"a_late_karambit_warrior":[1.0,0.95,1.05,"li"],"a_the_black_army":[1.0,1.0,0.95,"hi"],"a_landsknechte":[1.0,1.05,0.95,"hi"],"a_late_gallowglass":[1.0,1.0,0.925,"hi"],"a_late_longbowmen":[1.0,0.95,0.95,"li"],"a_paik":[1.0,0.9,1.05,"li"],"a_paik_infantry":[1.0,0.95,1.0,"li"],"a_lanzas_de_castilla":[4.0,1.0,0.647,"hc"],"a_akinji":[4.0,0.95,0.788,"lc"],"a_reislaufer":[1.0,1.0,0.825,"hi"],"a_cetbang_cannon":[4.0,1.0,1.25,"art"],"a_dahomey_amazons":[1.0,1.05,0.95,"hi"],"a_esho_cavalry_oyo":[4.0,0.95,0.788,"lc"],"a_florentine_citizen_militia":[1.0,0.95,1.025,"li"],"a_naft_throwers":[1.0,0.975,1.1,"li"],"a_iron_helmet_musketeers":[1.5,1.1,1.0,"hi"],"a_hungarian_hussars":[4.0,0.95,0.788,"lc"],"a_pontifical_swiss_guard":[1.5,1.15,0.925,"hi"],"a_mauricians":[1.5,1.0,1.0,"hi"],"a_tercio":[1.5,1.05,0.9,"hi"],"a_sowar_cavalry":[4.0,1.075,0.75,"hc"],"a_winged_hussars":[4.0,1.125,0.75,"hc"],"a_red_cannon":[5.0,1.025,1.25,"art"],"a_banner_cavalry":[4.0,1.05,0.75,"hc"],"a_ghilman":[1.5,1.0,1.0,"hi"],"a_saxon_defensioner":[1.5,1.0,0.95,"hi"],"a_hesse_jager":[1.5,0.95,1.1,"li"],"a_gebirgsschutzen_infantry":[1.5,0.95,1.1,"li"],"a_byz_helepolis_cannon_unit":[0.25,1.0,1.25,"art"],"a_hakkapelitta":[4.0,1.0,0.75,"lc"],"a_caroleans":[2.25,1.125,0.9,"hi"],"a_scottish_highlander":[2.25,1.1,1.05,"hi"],"a_late_paik":[2.25,0.9,1.05,"li"],"a_late_paik_infantry":[2.25,0.95,1.0,"li"],"a_late_winged_hussars":[4.0,1.175,0.75,"hc"],"a_tofangchi":[2.25,1.0,1.0,"hi"],"a_tupchi":[5.5,1.1,1.25,"art"],"a_black_guard":[2.25,1.05,1.0,"hi"],"a_prussian_grenadiers":[2.25,1.15,1.0,"hi"],"a_bavarian_jager":[2.25,0.95,1.05,"li"],"a_hajduk":[2.25,0.95,1.1,"li"],"a_redcoats":[3.0,1.0,0.95,"hi"],"a_experimental_riflemen":[3.0,0.95,1.05,"li"],"a_cacadores":[3.0,1.0,0.925,"hi"],"a_gurkha":[3.0,1.0,0.925,"hi"],"a_jazayerchi":[3.0,1.1,1.0,"hi"],"a_austrian_grenzhussar":[4.0,0.95,0.788,"lc"],"a_pandur":[3.0,0.95,1.05,"li"],"a_austrian_grenzer":[3.0,0.95,1.05,"li"],"a_grenadiers":[3.0,1.1,1.05,"hi"],"a_renaissance_conquistadors":[1.0,1.1,0.95,"hi"],"a_discovery_conquistadors":[1.0,1.1,0.95,"hi"],"a_footmen":[1.0,1.0,0.975,"hi"],"a_archers":[1.0,0.95,1.05,"li"],"a_footmen_levy":[1.0,1.0,0.975,"hi"],"a_horsemen":[4.0,0.95,0.788,"lc"],"a_armored_horsemen":[4.0,1.0,0.75,"hc"],"a_camp_followers":[0.25,1.0,1.25,"aux"],"a_men_at_arms":[1.0,1.0,0.95,"hi"],"a_crossbowmen":[1.0,0.95,1.05,"li"],"a_handgonners":[1.0,1.05,1.0,"li"],"a_men_at_arms_levy":[1.0,1.0,0.95,"hi"],"a_cavalrymen":[4.0,0.95,0.788,"lc"],"a_heavy_cavalrymen":[4.0,1.0,0.75,"hc"],"a_houfnice":[3.0,1.0,1.25,"art"],"a_peasant_levy":[1.0,0.95,1.05,"li"],"a_supply_carts":[0.25,1.0,1.25,"aux"],"a_early_arquebusiers":[1.0,0.95,1.05,"li"],"a_halberdiers":[1.0,1.0,1.0,"hi"],"a_light_lancers":[4.0,0.95,0.788,"lc"],"a_lancers":[4.0,1.0,0.75,"hc"],"a_falconet":[4.0,1.0,1.25,"art"],"a_matchlock_levy":[1.0,0.95,1.05,"li"],"a_supply_convoy":[0.25,1.0,1.25,"aux"],"a_arquebusiers":[1.5,0.95,1.05,"li"],"a_pikemen":[1.5,1.0,1.0,"hi"],"a_pistoleers":[4.0,0.95,0.788,"lc"],"a_heavy_lancers":[4.0,1.0,0.75,"hc"],"a_chambered_cannon":[5.0,1.0,1.25,"art"],"a_flintlock_levy":[1.5,0.95,1.05,"li"],"a_baggage_train":[0.25,1.0,1.25,"aux"],"a_hunters":[2.25,0.95,1.05,"li"],"a_musketeers":[2.25,1.0,1.0,"hi"],"a_hussars":[4.0,0.95,0.788,"lc"],"a_gallop_cavalry":[4.0,1.0,0.75,"hc"],"a_royal_mortar":[5.5,1.0,1.25,"art"],"a_militiamen":[2.25,0.95,1.05,"li"],"a_wagon_train":[0.25,1.0,1.25,"aux"],"a_sharpshooters":[3.0,0.95,1.05,"li"],"a_fusiliers":[3.0,1.0,1.0,"hi"],"a_light_dragoons":[4.0,0.95,0.788,"lc"],"a_cuirassiers":[4.0,1.0,0.75,"hc"],"a_flying_battery":[7.5,1.0,1.25,"art"],"a_conscripts":[3.0,0.95,1.05,"li"],"a_logistics_corps":[0.25,1.0,1.25,"aux"],"a_cawa":[1.0,1.0,0.95,"hi"],"a_renaissance_cawa":[1.0,1.0,0.95,"hi"],"a_discovery_cawa":[1.0,1.0,0.95,"hi"],"a_reformation_cawa":[1.5,1.0,0.95,"hi"],"a_absolutism_cawa":[2.25,1.0,0.95,"hi"],"a_revolutions_cawa":[3.0,1.0,0.95,"hi"],"a_indian_elephant_auxiliary":[2.0,1.0,1.25,"aux"],"a_indian_elephant_cavalry":[4.0,1.0,0.75,"hc"],"a_orissan_elephant_cavalry":[4.0,1.0,0.712,"hc"],"a_bengali_elephant_cavalry":[4.0,1.0,0.75,"hc"],"a_thai_elephant_cavalry":[4.0,1.0,0.75,"hc"],"a_siamese_advanced_elephant_cavalry":[4.0,1.125,0.75,"hc"],"a_khmer_ballista_elephant_infantry":[1.0,1.0,1.0,"hi"],"a_renaissance_janissaries":[1.0,1.0,0.9,"hi"],"a_discovery_janissaries":[1.0,1.0,0.9,"hi"],"a_reformation_janissaries":[1.5,1.0,0.9,"hi"],"a_absolutism_janissaries":[2.25,1.0,0.9,"hi"],"a_revolutions_janissaries":[3.0,1.0,0.9,"hi"],"a_discovery_qizilbash":[4.0,1.0,0.788,"lc"],"a_reformation_qizilbash":[4.0,1.05,0.788,"lc"],"a_legionaries_1":[1.0,1.0,0.9,"hi"],"a_legionaries_2":[1.0,1.0,0.9,"hi"],"a_legionaries_3":[1.0,1.0,0.9,"hi"],"a_legionaries_4":[1.5,1.0,0.9,"hi"],"a_legionaries_5":[2.25,1.0,0.9,"hi"],"a_legionaries_6":[3.0,1.0,0.9,"hi"],"a_byzantine_cataphracts_2":[4.0,1.165,0.656,"hc"],"a_byzantine_cataphracts_3":[4.0,1.165,0.656,"hc"],"a_byzantine_cataphracts_4":[4.0,1.165,0.656,"hc"],"a_byzantine_cataphracts_5":[4.0,1.165,0.656,"hc"],"a_byzantine_cataphracts_6":[4.0,1.165,0.656,"hc"],"a_varangians_2":[1.0,1.2,1.0,"hi"],"a_varangians_3":[1.0,1.2,1.0,"hi"],"a_varangians_4":[1.5,1.2,1.0,"hi"],"a_varangians_5":[2.25,1.2,1.0,"hi"],"a_varangians_6":[3.0,1.2,1.0,"hi"],"a_greek_fire_renaissance_infantry":[1.0,1.1,1.05,"li"],"a_greek_fire_discovery_infantry":[1.0,1.1,1.05,"li"],"a_bedouin_cavalry":[4.0,0.95,0.788,"lc"],"a_jaguar_warrior":[1.0,1.05,0.95,"hi"],"a_eagle_warrior":[1.0,0.95,1.05,"li"],"a_war_party":[1.0,0.95,1.05,"li"],"a_lodge_warriors":[1.0,1.0,1.0,"hi"]};

// Military power. In combat a regiment deals combat power x men x (1 +
// discipline) damage, levies only 75% of that (LAND_LEVY_COMBAT_IMPACT)
// times (1 + levy combat ability), and with 10% less discipline (the
// is_army_levy modifier); military tactics and discipline both
// cut the damage it takes. So each side's punch is the sum of what its
// regiments deal and its staying power the men it has over the damage they
// take; by Lanchester's square law a force is worth sqrt(punch x staying
// power). The score is in thousands of plain regular infantry (combat power
// 1, no discipline, tactics 1), so a bare 10,000-man infantry army scores 10.
const LAND_LEVY_COMBAT_IMPACT = 0.75;
const LEVY_DISCIPLINE = -0.10;
const BASE_TACTICS = 1;
// Unraised levies: nobles ride as heavy cavalry, everyone else marches as
// the current age's light infantry.
const levyProfile = (age, nobles) =>
  UNIT_STATS[`a_${age}_${nobles ? "heavy_cavalry" : "light_infantry"}`] ||
  (nobles ? [4, 1, 0.75, "hc"] : [1, 0.95, 1.05, "li"]);
// Unit categories, as the save's unit types and the *_power modifiers name them.
const UNIT_CATS = ["li", "hi", "lc", "hc", "art", "aux"];
const byCat = () => Object.fromEntries(UNIT_CATS.map((k) => [k, 0]));
/* A combat sum: damage dealt per unit category (o), staying power (h), men. */
const emptySum = () => ({ o: byCat(), h: 0, men: 0 });


const prettyKey = (k) => String(k).replace(/_/g, " ").replace(/\s+/g, " ").trim();

/* {discipline_est, levy_combat_est, tactics_est, unit_power: {category: bonus},
    mil_sources: [[label, d, l, t, {category: bonus}]], _ruler} */
function estimateMilitary(c, rulerId) {
  const S = MIL_SOURCES, src = [];
  const addSrc = (label, m, scale = 1) => src.push(...milSource(label, m, scale));
  const gov = get(c, "government");
  const reforms = new Set();
  for (const e of asList(get(gov, "implemented_reforms"))) {
    const o = get(e, "object");
    if (typeof o === "string") reforms.add(o);
  }
  const blockOk = (b) => (!b.reform || reforms.has(b.reform)) && (!b.not_reform || !reforms.has(b.not_reform));
  const adv = get(c, "researched_advances");
  if (isDict(adv)) for (const [k, v] of adv) if (v === "yes" && S.advance[k]) addSrc("Advance: " + prettyKey(k), S.advance[k]);
  const laws = get(gov, "implemented_laws");
  if (isDict(laws)) for (const [, law] of laws) {
    const o = get(law, "object");
    for (const b of S.policy[o] || []) if (blockOk(b)) addSrc("Policy: " + prettyKey(o), b);
  }
  for (const e of asList(get(gov, "implemented_privileges"))) {
    const o = get(e, "object");
    for (const b of S.privilege[o] || []) if (blockOk(b)) addSrc("Privilege: " + prettyKey(o), b);
  }
  for (const o of reforms) for (const b of S.reform[o] || []) if (blockOk(b)) addSrc("Reform: " + prettyKey(o), b);
  const sv = get(gov, "societal_values");
  if (isDict(sv)) for (const [k, v] of sv) {
    const x = num(v, NaN), def = S.societal[k];
    if (!def || !Number.isFinite(x) || x < -100 || x > 100) continue;
    // negative leans to the left-hand value, positive to the right
    if (x < 0 && def.left) addSrc("Societal value: " + prettyKey(k.split("_vs_")[0]), def.left, -x / 100);
    if (x > 0 && def.right) addSrc("Societal value: " + prettyKey(k.split("_vs_")[1] || k), def.right, x / 100);
  }
  for (const t of asList(get(get(c, "timed_modifiers"), "timed_modifiers"))) {
    const name = get(t, "modifier"), def = S.modifier[name];
    if (def) addSrc("Modifier: " + prettyKey(name), def, num(get(t, "size"), 1) || 1);
  }
  return { mil_sources: src, _ruler: typeof rulerId === "string" ? rulerId : null, ...totalMilitary(src) };
}

/* [[label, d, l, t, {category: bonus}]] for one source, or [] if it gives none. */
function milSource(label, m, scale = 1) {
  const d = (m.d || 0) * scale, l = (m.l || 0) * scale, t = (m.t || 0) * scale;
  const p = {};
  for (const k of UNIT_CATS) if (m[k]) p[k] = m[k] * scale;
  return d || l || t || Object.keys(p).length ? [[label, d, l, t, p]] : [];
}

function totalMilitary(src) {
  let d = 0, l = 0, t = BASE_TACTICS;
  const p = byCat();
  for (const s of src) {
    d += s[1]; l += s[2]; t += s[3] || 0;
    for (const [k, v] of Object.entries(s[4] || {})) if (k in p) p[k] += v;
  }
  return { discipline_est: d, levy_combat_est: l, tactics_est: t, unit_power: p };
}

/* Military power from a country's combat sums (see LAND_LEVY_COMBAT_IMPACT)
   and its estimated discipline, levy combat ability, tactics and unit
   category bonuses. Each sum is {o: {category: combat power x men x damage
   done}, h: men / damage taken, men}. */
function militaryPower(r, regSum, raisedSum, unraisedSum) {
  // the category bonuses raise combat power, so they scale damage dealt
  const dealt = (sum) => ({ o: UNIT_CATS.reduce((a, k) => a + sum.o[k] * Math.max(0, 1 + (r.unit_power[k] || 0)), 0),
    h: sum.h, men: sum.men });
  const reg = dealt(regSum), raised = dealt(raisedSum), unraised = dealt(unraisedSum);
  const disc = Math.max(0.05, 1 + r.discipline_est);
  // levies also take the is_army_levy modifier's -10% discipline
  const levyDisc = Math.max(0.05, disc + LEVY_DISCIPLINE);
  const levyQ = LAND_LEVY_COMBAT_IMPACT * Math.max(0, 1 + r.levy_combat_est);
  const tac = Math.max(0.1, r.tactics_est);
  const power = (o, h) => (o > 0 && h > 0 ? Math.sqrt(o * h) : 0);
  const field = { o: reg.o * disc + raised.o * levyQ * levyDisc, h: (reg.h * disc + raised.h * levyDisc) * tac };
  const full = { o: field.o + unraised.o * levyQ * levyDisc, h: field.h + unraised.h * levyDisc * tac };
  const fullMen = reg.men + raised.men + unraised.men;
  return {
    mil_power: power(full.o, full.h),
    mil_power_field: power(field.o, field.h),
    mil_power_regulars: power(reg.o * disc, reg.h * disc * tac),
    // what one man is worth, against plain regular infantry
    mil_quality: fullMen ? power(full.o, full.h) / fullMen : 0,
    mil_punch: full.o, mil_staying: full.h,
  };
}

/* {institutions: [embraced, in age order], n_institutions,
    inst_presence: {institution: share of people exposed}} for one country.
   Presence is kept for institutions that have appeared but aren't embraced. */
function institutionFigures(c, exposed, people, order) {
  const has = get(c, "institutions");
  const got = new Set();
  if (isDict(has)) for (const [k, v] of has) if (v === "yes") got.add(k);
  const known = order.map((i) => i.key);
  const list = [...known.filter((k) => got.has(k)), ...[...got].filter((k) => !known.includes(k))];
  const presence = {};
  for (const i of order) {
    if (!i.active || got.has(i.key)) continue;
    const v = exposed && people ? exposed.val(i.key) / people : 0;
    presence[i.key] = Math.round(v * 1000) / 1000;
  }
  return { institutions: list, n_institutions: list.length, inst_presence: presence };
}

/* Ruler traits live in character_db; look up just the rulers shown. */
async function attachRulerTraits(rows, save, sections) {
  const want = new Map(rows.filter((r) => r._ruler).map((r) => [r._ruler, r]));
  if (want.size && sections.has("character_db")) {
    const text = await readSpan(save, ...sections.get("character_db")[0]);
    for (const [id, r] of want) {
      const at = text.indexOf("\n" + id + "={");
      if (at < 0) continue;
      const end = text.indexOf("\n}", at + 1);
      const body = text.slice(at, end > 0 ? end : at + 4000);
      const tm = body.match(/\n\ttraits=\{([^}]*)\}/);
      for (const t of tm ? tm[1].split(/\s+/).filter(Boolean) : []) {
        const def = MIL_SOURCES.trait[t];
        if (def) r.mil_sources.push(...milSource("Ruler trait: " + prettyKey(t), def));
      }
      Object.assign(r, totalMilitary(r.mil_sources));
    }
  }
  for (const r of rows) delete r._ruler;
}

/* A country's combat sums with its levies not yet raised added in: the
   potential levies beyond those already in the field, split between
   nobles (cavalry) and everyone else (infantry) in the save's proportion. */
function combatFigures(cs, potential, raised, nobleShare, age) {
  const c = cs || { reg: emptySum(), raised: emptySum(), cls: byCat() };
  const rest = Math.max(0, potential - raised);
  const nob = potential > 0 ? rest * Math.min(1, nobleShare / potential) : 0;
  const unraised = emptySum();
  unraised.men = rest;
  const cls = { ...c.cls };
  for (const [men, nobles] of [[nob, true], [rest - nob, false]]) {
    const p = levyProfile(age, nobles);
    unraised.o[p[3]] += men * p[0] * p[1];
    unraised.h += men / p[2];
    cls[p[3]] += men;
  }
  return { reg: c.reg, raised: c.raised, unraised, cls };
}

/* Advances gained since the start: everything researched, minus the ones a
   country of its starting technology level begins the game with. The save
   keeps no research dates, so this is the only baseline available. */
function attachAdvanceGains(rows, table) {
  for (const r of rows) {
    const done = r._researched, level = r._startLevel;
    delete r._researched;
    delete r._startLevel;
    if (!done || level == null) continue;
    const start = done.filter((a) => a in table && table[a] <= level).length;
    r.advances_start = start;
    r.advances_gained = done.length - start;
  }
}

// ==========================================================================
// Python-compatibility helpers
// ==========================================================================
const isDict = (x) => x instanceof Map;
const get = (d, k, dflt) => (isDict(d) && d.has(k) ? d.get(k) : dflt);
/* Python truthiness, for the many `x or default` idioms in the original. */
function truthy(x) {
  if (x == null || x === "" || x === 0 || x === false) return false;
  if (Array.isArray(x)) return x.length > 0;
  if (isDict(x)) return x.size > 0;
  return true;
}
const or = (x, d) => (truthy(x) ? x : d);
/* Python's round(): half to even. */
function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

class Counter extends Map {
  add(k, v) { this.set(k, (this.get(k) || 0) + v); }
  val(k) { return this.get(k) || 0; }
  total() { let s = 0; for (const v of this.values()) s += v; return s; }
}

// ==========================================================================
// Clausewitz plaintext parser (small chunks only). Blocks become Map (keyed,
// insertion-ordered, with bare items under "__items__") or Array (bare list).
// ==========================================================================
function parse(s) {
  const n = s.length;
  let i = 0;

  function skip() {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 13 || c === 10) i++;
      else if (c === 35) { while (i < n && s.charCodeAt(i) !== 10) i++; }
      else break;
    }
  }
  // tokens: "{" "}" "=" or a string value (typeof "string" with a marker)
  const OPEN = { t: "{" }, CLOSE = { t: "}" }, EQ = { t: "=" };
  function tok() {
    skip();
    if (i >= n) return null;
    const c = s[i];
    if (c === "{") { i++; return OPEN; }
    if (c === "}") { i++; return CLOSE; }
    if (c === "=") { i++; return EQ; }
    if (c === '"') {
      i++;
      let buf = "";
      let st = i;
      while (i < n) {
        const ch = s[i];
        if (ch === "\\") { buf += s.slice(st, i) + (s[i + 1] ?? ""); i += 2; st = i; }
        else if (ch === '"') { buf += s.slice(st, i); i++; st = -1; break; }
        else i++;
      }
      if (st !== -1) buf += s.slice(st, Math.min(i, n));
      return { t: "v", v: buf };
    }
    const st = i;
    while (i < n) {
      const ch = s.charCodeAt(i);
      if (ch === 32 || ch === 9 || ch === 13 || ch === 10 || ch === 61 || ch === 123 || ch === 125) break;
      i++;
    }
    return { t: "v", v: s.slice(st, i) };
  }
  function obj() {
    const d = new Map(), lst = [];
    for (;;) {
      const t = tok();
      if (t === null || t === CLOSE) break;
      if (t === OPEN) { lst.push(obj()); continue; }
      if (t === EQ) continue;
      const key = t.v;
      const save = i;
      const t2 = tok();
      if (t2 === null) { lst.push(key); break; }
      if (t2 === EQ) {
        const t3 = tok();
        if (t3 === null) throw new Error("unexpected end of block");
        let val;
        if (t3 === OPEN) val = obj();
        else if (t3.t === "v") val = t3.v;
        else throw new Error("unexpected token " + t3.t);
        if (d.has(key)) {
          const cur = d.get(key);
          if (Array.isArray(cur) && cur.__dup) cur.push(val);
          else { const arr = [cur, val]; arr.__dup = true; d.set(key, arr); }
        } else d.set(key, val);
      } else {
        lst.push(key);
        i = save;
      }
    }
    if (lst.length && !d.size) return lst;
    if (lst.length) d.set("__items__", lst);
    return d;
  }
  skip();
  if (i < n && s[i] === "{") i++;
  return obj();
}

function asList(x) {
  if (x == null) return [];
  if (Array.isArray(x)) return x;
  if (isDict(x)) return x.has("__items__") ? x.get("__items__") : [x];
  return [x];
}

function num(x, dflt = 0.0) {
  if (typeof x === "number") return x;
  if (typeof x !== "string") return dflt;
  const s = x.trim().replace(/_/g, "");
  if (!s) return dflt;
  const v = Number(s);
  if (Number.isNaN(v)) {
    const l = s.toLowerCase();
    if (l === "nan") return NaN;
    if (l === "inf" || l === "+inf" || l === "infinity") return Infinity;
    if (l === "-inf" || l === "-infinity") return -Infinity;
    return dflt;
  }
  return v;
}

// ==========================================================================
// Game files: they stay on the page, which answers one request at a time.
// (Handing the worker thousands of file references in a single message can
// make the browser drop the worker.) Paths are relative to the install's
// `game` folder.
// ==========================================================================
let fsSeq = 0;
const fsWaiting = new Map();
function fsCall(op, rel) {
  return new Promise((resolve) => {
    const id = ++fsSeq;
    fsWaiting.set(id, resolve);
    postMessage({ type: "fs", id, op, rel });
  });
}
function fsReply(msg) {
  const done = fsWaiting.get(msg.id);
  fsWaiting.delete(msg.id);
  if (done) done(msg.result);
}

class GameFS {
  constructor(src) {
    this.label = src.label || "your EU5 install";
  }
  /* File, or null if missing */
  file(rel) {
    return fsCall("file", rel);
  }
  async text(rel) {
    const f = await this.file(rel);
    if (!f) return null;
    const t = await f.text();
    return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
  }
  /* file names (not subfolders) directly inside rel, or null if missing */
  list(rel) {
    return fsCall("list", rel);
  }
}
const pySort = (arr) => arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// ==========================================================================
// Coat-of-arms rendering
//
// Channel conventions, measured against the shipped 1.3.11 textures:
//   patterns        R/G/B are full-intensity masks for colour1/2/3.
//   colored_emblems body is colour1; G blends toward colour2, R toward
//                   colour3. B sits at a constant ~0.5 in every emblem and
//                   carries no colour information.
// ==========================================================================
function hsvToRgb(h, s, v) {
  let r, g, b;
  if (s === 0) r = g = b = v;
  else {
    let i = Math.trunc(h * 6.0);
    const f = h * 6.0 - i;
    const p = v * (1.0 - s), q = v * (1.0 - s * f), t = v * (1.0 - s * (1.0 - f));
    i = ((i % 6) + 6) % 6;
    [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  }
  return [pyRound(r * 255), pyRound(g * 255), pyRound(b * 255)];
}

function colorFrom(kind, body) {
  const parts = body.split(/\s+/).filter(Boolean);
  const vals = [];
  for (const p of parts) {
    const v = num(p, NaN);
    if (Number.isNaN(v)) return null;
    vals.push(v);
  }
  if (vals.length < 3) return null;
  if (kind === "rgb") return vals.slice(0, 3).map((v) => pyRound(v > 1 ? v : v * 255));
  if (kind === "hsv360") return hsvToRgb(vals[0] / 360.0, vals[1] / 100.0, vals[2] / 100.0);
  return hsvToRgb(vals[0], vals[1], vals[2]);
}

async function loadNamedColors(fs) {
  const out = new Map();
  const dir = "main_menu/common/named_colors";
  const names = await fs.list(dir);
  if (!names) return out;
  for (const fn of pySort(names)) {
    const txt = await fs.text(dir + "/" + fn);
    if (txt == null) continue;
    for (const m of txt.matchAll(/(\w+)\s*=\s*(rgb|hsv360|hsv)\s*\{([^}]*)\}/g)) {
      const c = colorFrom(m[2], m[3]);
      if (c) out.set(m[1], c);
    }
  }
  return out;
}

async function loadCoaDefs(fs) {
  const defs = new Map(), variables = new Map();
  const dir = "main_menu/common/coat_of_arms/coat_of_arms";
  const names = (await fs.list(dir)) || [];
  for (const fn of pySort(names)) {
    if (!fn.endsWith(".txt")) continue;
    let txt = await fs.text(dir + "/" + fn);
    if (txt == null) continue;
    for (const m of txt.matchAll(/^@(\w+)\s*=\s*([-\d.]+)/gm)) variables.set(m[1], m[2]);
    txt = txt.replace(/@(\w+)/g, (_, k) => (variables.has(k) ? variables.get(k) : "0"));
    const starts = [...txt.matchAll(/^(\w+)\s*=\s*\{/gm)].map((m) => [m[1], m.index + m[0].length]);
    for (let i = 0; i < starts.length; i++) {
      const [key, s0] = starts[i];
      const e = i + 1 < starts.length ? starts[i + 1][1] : txt.length;
      const chunk = txt.slice(s0, e);
      let depth = 1, j = 0, inq = false;
      while (j < chunk.length && depth > 0) {
        const c = chunk[j];
        if (inq) inq = c !== '"';
        else if (c === '"') inq = true;
        else if (c === "{") depth++;
        else if (c === "}") depth--;
        j++;
      }
      if (!defs.has(key)) defs.set(key, chunk.slice(0, Math.max(0, j - 1)));
    }
  }
  return defs;
}

function canvas(w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return [c, ctx];
}

/* float RGB (w*h*3) + float alpha (w*h) -> canvas, truncating like numpy */
function floatToCanvas(rgb, a, w, h) {
  const [c, ctx] = canvas(w, h);
  const id = ctx.createImageData(w, h);
  const d = id.data;
  for (let p = 0, q = 0; p < w * h; p++, q += 3) {
    d[p * 4] = Math.trunc(clamp01(rgb[q]) * 255);
    d[p * 4 + 1] = Math.trunc(clamp01(rgb[q + 1]) * 255);
    d[p * 4 + 2] = Math.trunc(clamp01(rgb[q + 2]) * 255);
    d[p * 4 + 3] = Math.trunc(clamp01(a[p]) * 255);
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

async function canvasToDataURI(c) {
  const blob = await c.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return "data:image/png;base64," + btoa(bin);
}

class FlagRenderer {
  constructor(fs) {
    this.fs = fs;
    this._tex = new Map();
  }
  async init() {
    this.colors = await loadNamedColors(this.fs);
    this.defs = await loadCoaDefs(this.fs);
  }
  /* -> {w, h, px: Uint8ClampedArray RGBA} or null */
  async tex(sub, name) {
    if (typeof name !== "string") throw new TypeError("bad texture name");
    const key = sub + "/" + name;
    if (!this._tex.has(key)) {
      let t = null;
      try {
        const f = name ? await this.fs.file("main_menu/gfx/coat_of_arms/" + key) : null;
        if (f) {
          const im = decodeDDS(await f.arrayBuffer());
          t = { w: im.width, h: im.height, px: im.data };
        }
      } catch (e) {
        t = null;
      }
      this._tex.set(key, t);
    }
    return this._tex.get(key);
  }
  _col(val, parent, dflt = [0, 0, 0]) {
    if (val == null) return dflt;
    if (typeof val !== "string") throw new TypeError("bad colour");
    if (/^color[1-5]$/.test(val)) return parent.has(val) ? parent.get(val) : dflt;
    return this.colors.get(val) || [128, 128, 128];
  }
  static over(rgb, alpha, srgb, sa) {
    for (let p = 0; p < alpha.length; p++) {
      const a = sa[p];
      rgb[p * 3] = srgb[p * 3] * a + rgb[p * 3] * (1 - a);
      rgb[p * 3 + 1] = srgb[p * 3 + 1] * a + rgb[p * 3 + 1] * (1 - a);
      rgb[p * 3 + 2] = srgb[p * 3 + 2] * a + rgb[p * 3 + 2] * (1 - a);
      alpha[p] = a + alpha[p] * (1 - a);
    }
  }
  /* Scale / flip / rotate an emblem and composite it at `pos`. Mirrors the
     PIL pipeline, including paste(im, box, mask=im) onto a transparent
     layer, which leaves the layer at rgb*a, alpha*a. */
  place(rgb, alpha, srgb, sa, sw0, sh0, pos, sc, rot, H, W) {
    const sw = Math.abs(sc[0]) * W, sh = Math.abs(sc[1]) * H;
    if (sw < 1 || sh < 1) return;
    const src = floatToCanvas(srgb, sa, sw0, sh0);
    const rw = Math.max(1, pyRound(sw)), rh = Math.max(1, pyRound(sh));
    const [c1, x1] = canvas(rw, rh);
    x1.translate(sc[0] < 0 ? rw : 0, sc[1] < 0 ? rh : 0);
    x1.scale(sc[0] < 0 ? -1 : 1, sc[1] < 0 ? -1 : 1);
    x1.drawImage(src, 0, 0, rw, rh);

    let img = c1, nw = rw, nh = rh;
    const ang = (((-rot) % 360) + 360) % 360;
    if (ang !== 0) {
      const r15 = (v) => Math.round(v * 1e15) / 1e15;
      const th = -ang * Math.PI / 180;
      const a = r15(Math.cos(th)), b = r15(Math.sin(th));
      const d = r15(-Math.sin(th)), e = r15(Math.cos(th));
      const cx = rw / 2, cy = rh / 2;
      const c = a * -cx + b * -cy + cx, f = d * -cx + e * -cy + cy;
      const xs = [], ys = [];
      for (const [x, y] of [[0, 0], [rw, 0], [rw, rh], [0, rh]]) {
        xs.push(a * x + b * y + c);
        ys.push(d * x + e * y + f);
      }
      nw = Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs));
      nh = Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys));
      const [c2, x2] = canvas(nw, nh);
      x2.translate(nw / 2, nh / 2);
      x2.rotate(ang === 90 || ang === 180 || ang === 270 ? -ang * Math.PI / 180 : th);
      x2.drawImage(c1, -rw / 2, -rh / 2);
      img = c2;
    }
    const [lc, lx] = canvas(W, H);
    lx.drawImage(img, pyRound(pos[0] * W - nw / 2), pyRound(pos[1] * H - nh / 2));
    const la = lx.getImageData(0, 0, W, H).data;
    const lrgb = new Float32Array(W * H * 3), laa = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) {
      const a = la[p * 4 + 3] / 255;
      lrgb[p * 3] = (la[p * 4] / 255) * a;
      lrgb[p * 3 + 1] = (la[p * 4 + 1] / 255) * a;
      lrgb[p * 3 + 2] = (la[p * 4 + 2] / 255) * a;
      laa[p] = a * a;
    }
    FlagRenderer.over(rgb, alpha, lrgb, laa);
  }
  async render(tag, H = 64, W = 96, depth = 0) {
    const body = this.defs.get(tag);
    if (body == null || depth > 3) return null;
    const d = parse("{" + body + "}");
    if (!isDict(d)) return null;
    const subs = asList(get(d, "sub"));
    if (subs.length && isDict(subs[0]) && truthy(get(subs[0], "parent"))) {
      const r = await this.render(get(subs[0], "parent"), H, W, depth + 1);
      if (r) return r;
    }
    const parent = new Map();
    for (let i = 1; i <= 5; i++) {
      const k = "color" + i;
      if (d.has(k)) {
        const v = d.get(k);
        if (typeof v !== "string") throw new TypeError("bad colour");
        parent.set(k, this.colors.get(v) || [128, 128, 128]);
      }
    }
    const rgb = new Float32Array(W * H * 3), alpha = new Float32Array(W * H);
    const pat = get(d, "pattern");
    if (truthy(pat)) {
      const t = await this.tex("patterns", pat);
      if (t) {
        const [pc, px] = canvas(W, H);
        const [sc0, sx0] = canvas(t.w, t.h);
        sx0.putImageData(new ImageData(new Uint8ClampedArray(t.px), t.w, t.h), 0, 0);
        px.drawImage(sc0, 0, 0, W, H);
        const tp = px.getImageData(0, 0, W, H).data;
        const c1 = parent.get("color1") || [128, 128, 128];
        const c2 = parent.get("color2") || [0, 0, 0];
        const c3 = parent.get("color3") || [0, 0, 0];
        const prgb = new Float32Array(W * H * 3), pa = new Float32Array(W * H);
        for (let p = 0; p < W * H; p++) {
          const r = tp[p * 4] / 255, g = tp[p * 4 + 1] / 255, b = tp[p * 4 + 2] / 255;
          const s = r + g + b;
          const on = s > 1e-4;
          const w0 = on ? r / s : 1, w1 = on ? g / s : 0, w2 = on ? b / s : 0;
          for (let k = 0; k < 3; k++)
            prgb[p * 3 + k] = clamp01(w0 * (c1[k] / 255) + w1 * (c2[k] / 255) + w2 * (c3[k] / 255));
          pa[p] = tp[p * 4 + 3] / 255;
        }
        FlagRenderer.over(rgb, alpha, prgb, pa);
      }
    }
    for (const [kind, folder] of [["colored_emblem", "colored_emblems"], ["textured_emblem", "textured_emblems"]]) {
      for (const em of asList(get(d, kind))) {
        if (!isDict(em)) continue;
        const t = await this.tex(folder, get(em, "texture", ""));
        if (!t) continue;
        const n = t.w * t.h;
        const ergb = new Float32Array(n * 3), ea = new Float32Array(n);
        if (kind === "colored_emblem") {
          const c1 = this._col(get(em, "color1"), parent);
          const c2 = this._col(get(em, "color2"), parent, c1);
          const c3 = this._col(get(em, "color3"), parent, c1);
          for (let p = 0; p < n; p++) {
            const r = t.px[p * 4] / 255, g = t.px[p * 4 + 1] / 255;
            for (let k = 0; k < 3; k++) {
              let v = (c1[k] / 255) * (1 - g) + (c2[k] / 255) * g;
              v = v * (1 - r) + (c3[k] / 255) * r;
              ergb[p * 3 + k] = clamp01(v);
            }
            ea[p] = t.px[p * 4 + 3] / 255;
          }
        } else {
          for (let p = 0; p < n; p++) {
            ergb[p * 3] = t.px[p * 4] / 255;
            ergb[p * 3 + 1] = t.px[p * 4 + 1] / 255;
            ergb[p * 3 + 2] = t.px[p * 4 + 2] / 255;
            ea[p] = t.px[p * 4 + 3] / 255;
          }
        }
        let insts = asList(get(em, "instance"));
        if (!insts.length) insts = [new Map()];
        for (let inst of insts) {
          if (!isDict(inst)) inst = new Map();
          const toF = (v) => {
            const x = num(v, NaN);
            if (Number.isNaN(x)) throw new TypeError("bad number");
            return x;
          };
          let pos = asList(get(inst, "position")).map(toF);
          let sc = asList(get(inst, "scale")).map(toF);
          const rr = asList(get(inst, "rotation"));
          const rot = rr.length ? toF(rr[0]) : 0.0;
          if (pos.length < 2) pos = [0.5, 0.5];
          if (sc.length < 2) sc = [1.0, 1.0];
          this.place(rgb, alpha, ergb, ea, t.w, t.h, pos, sc, rot, H, W);
        }
      }
    }
    // Final image drops alpha (PIL convert("RGB")), keeping the raw colour.
    const [oc, ox] = canvas(W, H);
    const id = ox.createImageData(W, H);
    for (let p = 0; p < W * H; p++) {
      id.data[p * 4] = Math.trunc(clamp01(rgb[p * 3]) * 255);
      id.data[p * 4 + 1] = Math.trunc(clamp01(rgb[p * 3 + 1]) * 255);
      id.data[p * 4 + 2] = Math.trunc(clamp01(rgb[p * 3 + 2]) * 255);
      id.data[p * 4 + 3] = 255;
    }
    ox.putImageData(id, 0, 0);
    return oc;
  }
  async dataURI(tag) {
    const c = await this.render(tag);
    return c ? canvasToDataURI(c) : null;
  }
}

async function attachFlags(rows, fs) {
  if (typeof OffscreenCanvas === "undefined") {
    log("flags: this browser can't draw off-screen - skipping");
    return 0;
  }
  const fr = new FlagRenderer(fs);
  await fr.init();
  if (!fr.defs.size) {
    log("flags: no coat-of-arms definitions found in " + fs.label + " - skipping");
    return 0;
  }
  let n = 0, done = 0;
  for (const r of rows) {
    progress(0.6 + 0.15 * (done++ / rows.length));
    let uri = null;
    try {
      uri = await fr.dataURI(r.tag);
    } catch (e) {
      uri = null;
    }
    if (uri) {
      r.flag = uri;
      n++;
    }
  }
  log(`flags: rendered ${n} of ${rows.length}`);
  return n;
}

// ==========================================================================
// Political map
// ==========================================================================
// The location numeric ID used by locations.locations.<id> in the save is
// the 1-based index of a depth-first walk of definitions.txt.
// named_locations/*.txt gives each named location's own flat display color;
// setup/countries/*.txt + named_colors gives each tag's in-game map color;
// location_templates.txt's topography field tells land from water.
const MAP_WATER_TOPO = new Set(["coastal_ocean", "ocean", "inland_sea", "deep_ocean", "lakes",
  "high_lakes", "ocean_wasteland", "narrows"]);
const MAP_BG = [235, 231, 220];     // water / unclassified
const MAP_LAND = [176, 172, 163];   // land not owned by a tracked nation
const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const rgbKey = (c) => (c[0] << 16) | (c[1] << 8) | c[2];

async function mapLocationNames(fs, mapd) {
  const tree = parse(await fs.text(mapd + "/definitions.txt"));
  const names = [];
  function walk(node) {
    if (isDict(node)) {
      for (const [k, v] of node) {
        if (k === "__items__") {
          for (const item of v) typeof item === "string" ? names.push(item) : walk(item);
          continue;
        }
        if (Array.isArray(v)) {
          if (v.length && v.every((x) => typeof x === "string")) names.push(...v);
          else for (const item of v) walk(item);
        } else if (isDict(v)) walk(v);
        else if (typeof v === "string") names.push(v);
      }
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    }
  }
  walk(tree);
  const out = new Map();
  names.forEach((nm, i) => out.set(i + 1, nm));
  return out;
}

async function mapLocationColors(fs, mapd) {
  const out = new Map();
  const dir = mapd + "/named_locations";
  const names = await fs.list(dir);
  if (!names) return out;
  for (const fn of pySort(names)) {
    if (!fn.endsWith(".txt")) continue;
    const txt = await fs.text(dir + "/" + fn);
    if (txt == null) continue;
    for (let line of txt.split(/\r\n|\r|\n/)) {
      line = line.split("#", 1)[0].trim();
      if (!line || !line.includes("=")) continue;
      const at = line.indexOf("=");
      const k = line.slice(0, at).trim();
      let v = line.slice(at + 1).trim();
      if (!/^[0-9a-fA-F]+$/.test(v)) continue;
      v = v.padStart(6, "0");
      out.set(k, [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]);
    }
  }
  return out;
}

async function mapTagSetup(fs, setupd) {
  const colornames = new Map(), color2 = new Map();
  const names = await fs.list(setupd);
  if (!names) return { colornames, color2 };
  for (const fn of pySort(names)) {
    if (!fn.endsWith(".txt")) continue;
    const txt = await fs.text(setupd + "/" + fn);
    if (txt == null) continue;
    for (const m of txt.matchAll(/^(\w+)\s*=\s*\{([\s\S]*?)^\}/gm)) {
      const [, tag, body] = m;
      const cm = body.match(/\bcolor\s*=\s*map_(\w+)/);
      if (cm) colornames.set(tag, cm[1]);
      const c2 = body.match(/\bcolor2\s*=\s*(rgb|hsv360|hsv)\s*\{([^}]*)\}/);
      if (c2) {
        const c = colorFrom(c2[1], c2[2]);
        if (c) color2.set(tag, c);
      }
    }
  }
  return { colornames, color2 };
}

function countryHeaderTags(ctext) {
  const idx = ctext.indexOf("database={");
  const header = idx !== -1 ? ctext.slice(0, idx) : ctext;
  const out = new Map();
  for (const m of header.matchAll(/\n\t\t(\d+)=([A-Za-z0-9_]+)/g)) out.set(m[1], m[2]);
  return out;
}

const MAP_VASSAL_RE = /dependency=\{\s*first=(\d+)\s*second=(\d+)\s*named_targets=\{\s*\{\s*flag="subject_type"\s*target=\{\s*type=subject_type\s*object=(\w+)/g;
const MAP_PU_RE = /scripted_mutual=\{\s*first=(\d+)\s*second=(\d+)\s*named_targets=\{\s*\{\s*flag="scripted_relation_type"\s*target=\{\s*type=relation_type\s*object=(\w+)/g;

/* subject country id -> [overlord tag, is_personal_union], for every
   dependency and personal union rooted at a tracked nation, walked
   transitively. is_personal_union is true only one direct PU hop from the
   root itself. */
async function mapSubjectOverlords(save, sections, cidToTag) {
  const out = new Map();
  if (!sections.has("diplomacy_manager")) return out;
  const dtext = await readSpan(save, ...sections.get("diplomacy_manager")[0]);
  const dep = new Map(), pu = new Map();
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const m of dtext.matchAll(MAP_VASSAL_RE)) add(dep, m[1], m[2]);
  for (const m of dtext.matchAll(MAP_PU_RE)) if (m[3] === "union_of_crowns_pact") add(pu, m[1], m[2]);

  for (const [rootCid, rootTag] of cidToTag) {
    const directPu = pu.get(rootCid) || new Set();
    const seen = new Set([rootCid]);
    let frontier = [rootCid];
    while (frontier.length) {
      const nxt = [];
      for (const cid of frontier) {
        for (const child of [...(dep.get(cid) || []), ...(pu.get(cid) || [])]) {
          if (seen.has(child)) continue;
          seen.add(child);
          if (!out.has(child)) out.set(child, [rootTag, directPu.has(child)]);
          nxt.push(child);
        }
      }
      frontier = nxt;
    }
  }
  return out;
}

/* Streaming decoder for an 8-bit, non-interlaced RGB/RGBA PNG. Calls
   onRow(y, row) with a Uint8Array of width*channels for every scanline,
   without ever holding the whole decoded image. */
async function decodePNGRows(file, onRow, onHeader) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((v, i) => buf[i] === v)) throw new Error("not a PNG");
  let off = 8, width = 0, height = 0, ch = 0;
  const idat = [];
  while (off < buf.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      const depth = data[8], ctype = data[9], interlace = data[12];
      if (depth !== 8 || (ctype !== 2 && ctype !== 6) || interlace !== 0)
        throw new Error(`unsupported PNG layout (depth ${depth}, type ${ctype}, interlace ${interlace})`);
      ch = ctype === 2 ? 3 : 4;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (onHeader) onHeader(width, height);
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const stride = width * ch;
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let filter = -1, fill = 0, y = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    let i = 0;
    while (i < value.length && y < height) {
      if (filter < 0) { filter = value[i++]; fill = 0; continue; }
      const take = Math.min(stride - fill, value.length - i);
      cur.set(value.subarray(i, i + take), fill);
      fill += take;
      i += take;
      if (fill < stride) break;
      switch (filter) {
        case 0: break;
        case 1: for (let x = ch; x < stride; x++) cur[x] = (cur[x] + cur[x - ch]) & 255; break;
        case 2: for (let x = 0; x < stride; x++) cur[x] = (cur[x] + prev[x]) & 255; break;
        case 3:
          for (let x = 0; x < stride; x++)
            cur[x] = (cur[x] + (((x >= ch ? cur[x - ch] : 0) + prev[x]) >> 1)) & 255;
          break;
        case 4:
          for (let x = 0; x < stride; x++) {
            const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          }
          break;
        default: throw new Error("bad PNG filter " + filter);
      }
      onRow(y, cur, ch);
      [prev, cur] = [cur, prev];
      y++;
      filter = -1;
    }
  }
  if (y < height) throw new Error("PNG ended early");
  return { width, height };
}

/* PIL-style resampling coefficients (ImagingResample precompute_coeffs). */
function lanczos(x) {
  const sinc = (v) => (v === 0 ? 1 : Math.sin(Math.PI * v) / (Math.PI * v));
  return x > -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0;
}
function resampleCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1);
  const support = 3 * filterscale;
  const out = [];
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const xmax = Math.min(inSize, Math.trunc(center + support + 0.5));
    const w = [];
    let ww = 0;
    for (let x = 0; x < xmax - xmin; x++) {
      const v = lanczos((x + xmin - center + 0.5) / filterscale);
      w.push(v);
      ww += v;
    }
    out.push({ min: xmin, w: new Float64Array(w.map((v) => (ww ? v / ww : v))) });
  }
  return out;
}
const clip8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/* Where the map's game data comes from - the linked install or a hosted
   game-data pack. Either way it gives: each location id's colour in
   locations.png, which of those colours are land, each tag's map colour and
   secondary colour, and the locations.png file itself. */
async function mapSourceFromGame(fs) {
  const mapd = "in_game/map_data", setupd = "in_game/setup/countries";
  const locFile = await fs.file(mapd + "/locations.png");
  if (!(await fs.file(mapd + "/definitions.txt")) || !locFile) return null;
  const idToName = await mapLocationNames(fs, mapd);
  const nameToRgb = await mapLocationColors(fs, mapd);
  const { colornames, color2 } = await mapTagSetup(fs, setupd);
  const namedColors = await loadNamedColors(fs);
  const land = new Set();
  const topo = await fs.text(mapd + "/location_templates.txt");
  if (topo != null) {
    for (const m of topo.matchAll(/(\S+)\s*=\s*\{[^}]*?topography\s*=\s*(\w+)/g)) {
      if (MAP_WATER_TOPO.has(m[2])) continue;
      const rgb = nameToRgb.get(m[1]);
      if (rgb) land.add(rgbKey(rgb));
    }
  }
  const tagRgb = (tag) => { const cn = colornames.get(tag); return cn ? namedColors.get("map_" + cn) || null : null; };
  return {
    label: fs.label, locFile, land, tagRgb,
    locRgb: (lid) => { const n = idToName.get(lid); return n ? nameToRgb.get(n) || null : null; },
    tagColor2: (tag) => color2.get(tag) || null,
    /* the same data as a compact JSON, for a hosted pack */
    toJSON() {
      const maxId = Math.max(0, ...idToName.keys()), locations = new Array(maxId + 1).fill(0);
      for (const [lid, name] of idToName) { const c = nameToRgb.get(name); if (c) locations[lid] = rgbKey(c); }
      const tags = {};
      for (const t of new Set([...colornames.keys(), ...color2.keys()])) {
        const a = tagRgb(t), b = color2.get(t);
        if (a || b) tags[t] = [a ? rgbKey(a) : null, b ? rgbKey(b) : null];
      }
      const names = new Array(maxId + 1).fill("");
      for (const [lid, name] of idToName) names[lid] = name;
      return { locations, land: [...land].sort((x, y) => x - y), tags, names };
    },
  };
}

const unKey = (k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255];
async function mapSourceFromPack(pack) {
  const [meta, locFile] = await Promise.all([packFetch(pack, "map.json", "json"), packFetch(pack, "locations.png", "blob")]);
  return {
    label: pack.label, locFile, land: new Set(meta.land),
    liveBase: new URL(pack.version + "/", PACK_ROOT).href,
    locRgb: (lid) => (meta.locations[lid] ? unKey(meta.locations[lid]) : null),
    tagRgb: (tag) => (meta.tags[tag] && meta.tags[tag][0] != null ? unKey(meta.tags[tag][0]) : null),
    tagColor2: (tag) => (meta.tags[tag] && meta.tags[tag][1] != null ? unKey(meta.tags[tag][1]) : null),
  };
}

// ==========================================================================
// Hosted game-data packs (gamedata/<version>/): flags pre-rendered with the
// same FlagRenderer, plus the map data, so reports get flags and a map
// without a linked install. Flag and map images are Paradox Interactive's,
// shared for non-commercial fan use.
// ==========================================================================
const PACK_ROOT = new URL("../gamedata/", self.location.href);
async function packFetch(pack, file, as) {
  const r = await fetch(new URL(pack.version + "/" + file, PACK_ROOT));
  if (!r.ok) throw new Error(`game data ${pack.version}/${file}: ${r.status}`);
  return as === "json" ? r.json() : r.blob();
}
const verKey = (v) => String(v || "").split(".").map((x) => parseInt(x, 10) || 0);
const verCmp = (a, b) => { const x = verKey(a), y = verKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

/* The pack for the save's game version, else the newest one. */
async function choosePack(saveVersion) {
  let index;
  try {
    const r = await fetch(new URL("index.json", PACK_ROOT));
    if (!r.ok) return null;
    index = await r.json();
  } catch (e) { return null; }
  const packs = (index.packs || []).slice().sort((a, b) => verCmp(b.version, a.version));
  if (!packs.length) return null;
  const exact = packs.find((p) => p.version === saveVersion);
  const p = exact || packs[0];
  return { ...p, exact: !!exact, label: `EU5 ${p.version}${p.name ? " “" + p.name + "”" : ""} game data` };
}

async function blobToDataURI(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return "data:" + (blob.type || "image/png") + ";base64," + btoa(bin);
}

async function attachFlagsFromPack(rows, pack) {
  let n = 0, done = 0;
  await Promise.all(rows.map(async (r) => {
    try {
      if (!/^[A-Z0-9_]{1,10}$/.test(r.tag)) return;
      const blob = await packFetch(pack, "flags/tag-" + r.tag + ".png", "blob");
      r.flag = await blobToDataURI(new Blob([blob], { type: "image/png" }));
      n++;
    } catch (e) { /* no pre-rendered flag for this tag */ }
    progress(0.6 + 0.15 * (++done / rows.length));
  }));
  log(`flags: ${n} of ${rows.length} from ${pack.label}`);
}

/* Build a pack from a linked install: every country tag's flag, and the
   map data. Used by tools/build-pack.html after a game patch. */
async function buildPack(fs) {
  stage("Reading the game's countries…");
  const tags = new Set();
  for (const fn of (await fs.list("in_game/setup/countries")) || []) {
    if (!fn.endsWith(".txt")) continue;
    const txt = await fs.text("in_game/setup/countries/" + fn);
    for (const m of (txt || "").matchAll(/^([A-Z0-9]{3})\s*=\s*\{/gm)) tags.add(m[1]);
  }
  const fr = new FlagRenderer(fs);
  await fr.init();
  // Starting countries, plus every tag-style coat of arms: formable and
  // releasable nations (Spain, ...) aren't in the setup files.
  for (const k of fr.defs.keys()) if (/^[A-Z][A-Z0-9_]{1,9}$/.test(k)) tags.add(k);
  const list = [...tags].filter((t) => fr.defs.has(t)).sort();
  const flags = {};
  let i = 0;
  for (const tag of list) {
    if (++i % 25 === 0) { stage(`Drawing flags… ${i} of ${list.length}`); progress(0.8 * i / list.length); }
    try {
      const c = await fr.render(tag);
      if (c) flags[tag] = await (await c.convertToBlob({ type: "image/png" })).arrayBuffer();
    } catch (e) { /* skip a flag the renderer can't draw */ }
  }
  stage("Reading the map data…");
  progress(0.85);
  const src = await mapSourceFromGame(fs);
  if (!src) throw new UserError("That folder has no map data (in_game/map_data).");
  const map = src.toJSON();
  const png = await src.locFile.arrayBuffer();
  // Half-resolution location-id map for the interactive map: each pixel's
  // green and blue hold its location id (nearest-neighbour downsample).
  stage("Building the interactive map raster…");
  progress(0.9);
  const lidOf = new Uint16Array(1 << 24);
  map.locations.forEach((k, lid) => { if (k) lidOf[k] = lid; });
  let raster = null, RW = 0;
  await decodePNGRows(src.locFile, (y, row, ch) => {
    if (y & 1) return;
    const out = raster, base = (y >> 1) * RW * 4;
    for (let x = 0, q = 0; x < RW; x++, q += 2 * ch) {
      const lid = lidOf[(row[q] << 16) | (row[q + 1] << 8) | row[q + 2]];
      out[base + x * 4 + 1] = lid >> 8; out[base + x * 4 + 2] = lid & 255; out[base + x * 4 + 3] = 255;
    }
  }, (w, h) => { RW = w >> 1; raster = new Uint8ClampedArray(RW * (h >> 1) * 4); });
  const rc = new OffscreenCanvas(RW, raster.length / 4 / RW);
  rc.getContext("2d").putImageData(new ImageData(raster, RW, rc.height), 0, 0);
  const rasterPng = await (await rc.convertToBlob({ type: "image/png" })).arrayBuffer();
  log(`pack: ${Object.keys(flags).length} flags of ${tags.size} country tags, ${map.locations.length - 1} locations, ${Object.keys(map.tags).length} tag colours`);
  stage("Reading the advances…");
  const advances = await loadAdvanceTable(fs);
  return { flags, map, png, raster: rasterPng, advances };
}

async function buildMapData(data, sections, save, msrc) {
  const t0 = performance.now();
  if (!msrc) {
    log("map: no map data available - skipping");
    return null;
  }
  if (!sections.has("locations")) {
    log("map: save has no locations section - skipping");
    return null;
  }
  if (typeof DecompressionStream === "undefined" || typeof OffscreenCanvas === "undefined") {
    log("map: this browser is missing DecompressionStream/OffscreenCanvas - skipping");
    return null;
  }
  const locFile = msrc.locFile;

  const rows = data.rows;
  const cidToTag = new Map(rows.map((r) => [r.id, r.tag]));
  const tagRgb = new Map();
  for (const r of rows) {
    // The game's setup colour, else the colour the save itself records
    // (covers tags formed or released mid-game).
    let rgb = msrc.tagRgb(r.tag);
    if (!rgb && r.color) rgb = [1, 3, 5].map((i) => parseInt(r.color.slice(i, i + 2), 16));
    tagRgb.set(r.tag, rgb);
  }

  let ltext = await readSpan(save, ...sections.get("locations")[0]);
  const locOwner = new Map();
  for (const part of ltext.split(/\n\t\t(?=\d+=\{)/)) {
    const idm = part.match(/^(\d+)=\{/);
    if (!idm) continue;
    const o = part.match(/\n\t\t\towner=(\d+)/);
    if (o) locOwner.set(parseInt(idm[1], 10), o[1]);
  }
  ltext = null;

  const subjectOverlord = await mapSubjectOverlords(save, sections, cidToTag);
  const allCidToTag = countryHeaderTags(await readSpan(save, ...sections.get("countries")[0]));

  // Per source colour: [rgb, isSubject, secondaryRgb]. Anything absent is
  // background (water / unclassified).
  const WHITE = [255, 255, 255];
  const state = new Map();
  for (const k of msrc.land) state.set(k, [MAP_LAND, false, WHITE]);
  const at = (k) => state.get(k) || [MAP_BG, false, WHITE];

  let nOver = 0;
  for (const [lid, cid] of locOwner) {
    const tag = cidToTag.get(cid);
    const rgb = tag ? tagRgb.get(tag) : null;
    if (!rgb) continue;
    const src = msrc.locRgb(lid);
    if (!src) continue;
    const k = rgbKey(src);
    const s = at(k);
    state.set(k, [rgb, s[1], s[2]]);
    nOver++;
  }
  if (nOver === 0) {
    log("map: no owned locations could be resolved to a color - skipping");
    return null;
  }

  let nSubj = 0, nPuSecondary = 0;
  for (const [lid, cid] of locOwner) {
    const ov = subjectOverlord.get(cid);
    if (!ov) continue;
    const [ovTag, isPu] = ov;
    const rgb = tagRgb.get(ovTag);
    if (!rgb) continue;
    const src = msrc.locRgb(lid);
    if (!src) continue;
    const k = rgbKey(src);
    const s = at(k);
    let sec = s[2];
    if (isPu) {
      const ownTag = allCidToTag.get(cid);
      const ownC2 = ownTag ? msrc.tagColor2(ownTag) : null;
      if (ownC2) {
        sec = ownC2;
        nPuSecondary++;
      }
    }
    state.set(k, [rgb, true, sec]);
    nSubj++;
  }

  // Collapse to a small palette; class 0 is background.
  const playerColors = new Set();
  for (const v of tagRgb.values()) if (v) playerColors.add(rgbKey(v));
  const palette = [[MAP_BG, false, WHITE]];
  const palIndex = new Map([[`${rgbKey(MAP_BG)}|0|${rgbKey(WHITE)}`, 0]]);
  const lut = new Uint16Array(1 << 24);
  for (const [k, s] of state) {
    const pk = `${rgbKey(s[0])}|${s[1] ? 1 : 0}|${rgbKey(s[2])}`;
    let idx = palIndex.get(pk);
    if (idx === undefined) {
      idx = palette.length;
      palette.push(s);
      palIndex.set(pk, idx);
    }
    lut[k] = idx;
  }
  const nPal = palette.length;
  const tracked = new Uint8Array(nPal);
  palette.forEach((s, i) => { tracked[i] = playerColors.has(rgbKey(s[0])) ? 1 : 0; });

  // One streaming pass over locations.png: classify every pixel and find the
  // bounding box of tracked territory.
  stage("Painting the map…");
  let cls = null, W0 = 0;
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  const onHeader = (w, h) => {
    W0 = w;
    fullRows = h;
    cls = nPal <= 256 ? new Uint8Array(w * h) : new Uint16Array(w * h);
  };
  let fullRows = 1;
  const { width: fullW, height: fullH } = await decodePNGRows(locFile, (y, row, ch) => {
    if ((y & 255) === 0) progress(0.78 + 0.17 * (y / fullRows));
    const w = W0;
    const base = y * w;
    let first = -1, last = -1;
    for (let x = 0, q = 0; x < w; x++, q += ch) {
      const c = lut[(row[q] << 16) | (row[q + 1] << 8) | row[q + 2]];
      cls[base + x] = c;
      if (tracked[c]) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first >= 0) {
      if (first < minX) minX = first;
      if (last > maxX) maxX = last;
      if (y < minY) minY = y;
      maxY = y;
    }
  }, onHeader);
  if (maxX < 0) {
    log("map: no colored pixels after recoloring - skipping");
    return null;
  }

  const padX = Math.trunc((maxX - minX) * 0.14), padY = Math.trunc((maxY - minY) * 0.14);
  const x0 = Math.max(0, minX - padX), x1 = Math.min(fullW, maxX + padX);
  const y0 = Math.max(0, minY - padY), y1 = Math.min(fullH, maxY + padY);
  const cw = x1 - x0, chh = y1 - y0;
  const targetW = 1900;
  let tw = cw, th = chh;
  if (cw > targetW) {
    tw = targetW;
    th = pyRound(chh * targetW / cw);
  }

  // Lanczos resize (horizontal pass into uint8, then vertical), like PIL.
  progress(0.95);
  const out = new Uint8ClampedArray(tw * th * 4);
  const hc = resampleCoeffs(cw, tw), vc = resampleCoeffs(chh, th);
  const hRows = new Map();
  const hRow = (sy) => {
    let r = hRows.get(sy);
    if (r) return r;
    r = new Uint8Array(tw * 3);
    const base = (y0 + sy) * W0 + x0;
    for (let ox = 0; ox < tw; ox++) {
      const { min, w } = hc[ox];
      let sr = 0, sg = 0, sb = 0;
      for (let j = 0; j < w.length; j++) {
        const c = palette[cls[base + min + j]][0];
        sr += c[0] * w[j]; sg += c[1] * w[j]; sb += c[2] * w[j];
      }
      r[ox * 3] = clip8(sr); r[ox * 3 + 1] = clip8(sg); r[ox * 3 + 2] = clip8(sb);
    }
    hRows.set(sy, r);
    return r;
  };
  for (let oy = 0; oy < th; oy++) {
    const { min, w } = vc[oy];
    for (const k of hRows.keys()) if (k < min) hRows.delete(k);
    const acc = new Float64Array(tw * 3);
    for (let j = 0; j < w.length; j++) {
      const r = hRow(min + j), wj = w[j];
      for (let q = 0; q < tw * 3; q++) acc[q] += r[q] * wj;
    }
    for (let ox = 0; ox < tw; ox++) {
      const o = (oy * tw + ox) * 4;
      out[o] = clip8(acc[ox * 3]); out[o + 1] = clip8(acc[ox * 3 + 1]);
      out[o + 2] = clip8(acc[ox * 3 + 2]); out[o + 3] = 255;
    }
  }

  // Hatch dependency / personal-union territory with a diagonal stripe,
  // sampled from the full-res classes with nearest-neighbour.
  if (nSubj) {
    for (let oy = 0; oy < th; oy++) {
      const sy = y0 + Math.min(chh - 1, Math.floor((oy + 0.5) * chh / th));
      for (let ox = 0; ox < tw; ox++) {
        const sx = x0 + Math.min(cw - 1, Math.floor((ox + 0.5) * cw / tw));
        const s = palette[cls[sy * W0 + sx]];
        if (!s[1]) continue;
        if ((((Math.floor((ox - oy) / 5) % 2) + 2) % 2) !== 0) continue;
        const o = (oy * tw + ox) * 4;
        for (let k = 0; k < 3; k++)
          out[o + k] = Math.trunc(Math.fround(out[o + k] * 0.45 + s[2][k] * 0.55));
      }
    }
  }
  cls = null;

  const [oc, ox] = canvas(tw, th);
  ox.putImageData(new ImageData(out, tw, th), 0, 0);
  const uri = await canvasToDataURI(oc);

  const legend = [];
  for (const r of rows) {
    const rgb = tagRgb.get(r.tag);
    if (!rgb) continue;
    legend.push({
      tag: r.tag, name: r.name, player: r.player, is_player: r.is_player,
      color: hex(rgb), locations: r.locations,
    });
  }
  log(`map: rendered ${tw}x${th}, ${legend.length}/${rows.length} nations placed, ` +
      `${nSubj} subject locations hatched (${nPuSecondary} with a personal-union ` +
      `secondary color) (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  // For the interactive map: players' colours and their subjects, keyed by
  // the owner indexes in data.locmap, and the area the static map shows.
  let live = null;
  const oIdx = data.locmap && data.locmap.ownerIdx;
  if (oIdx && msrc.liveBase) {
    const tagCid = new Map([...cidToTag].map(([c, t]) => [t, c]));
    const pcol = {}, subj = {};
    for (const r of rows) { const rgb = tagRgb.get(r.tag); if (rgb && oIdx.has(r.id)) pcol[oIdx.get(r.id)] = hex(rgb); }
    for (const [cid, [rootTag, isPu]] of subjectOverlord) {
      if (!oIdx.has(cid) || !oIdx.has(tagCid.get(rootTag))) continue;
      const own = allCidToTag.get(cid), c2 = isPu && own ? msrc.tagColor2(own) : null;
      subj[oIdx.get(cid)] = [oIdx.get(tagCid.get(rootTag)), c2 ? hex(c2) : "#ffffff"];
    }
    live = { base: msrc.liveBase, view: [x0 / fullW, y0 / fullH, x1 / fullW, y1 / fullH], pcol, subj };
  }
  return { image: uri, legend, has_subjects: nSubj > 0, bg: hex(MAP_BG), land: hex(MAP_LAND), live };
}

// ==========================================================================
// Save file handling
// ==========================================================================
async function checkPlaintext(save) {
  const head = new Uint8Array(await save.slice(0, 32).arrayBuffer());
  const txt = String.fromCharCode(...head);
  if (!txt.startsWith("SAV")) throw new UserError(`${save.name} does not look like an EU5 save.`);
  if (txt.slice(5, 7) !== "00") {
    throw new UserError(
      `${save.name} is a packed save (header ${txt.slice(0, 9)}), and only debug-mode ` +
      "plaintext saves can be read. See “Making a readable save” below.", "packed");
  }
}
class UserError extends Error {
  constructor(msg, code) { super(msg); this.code = code || "user"; }
}

const isKeyStart = (b) => b >= 97 && b <= 122;
const isKeyChar = (b) => (b >= 97 && b <= 122) || (b >= 48 && b <= 57) || b === 95;
const isSpace = (b) => b === 32 || b === 9 || b === 13 || b === 11 || b === 12;

/* One pass over the file. Returns Map name -> [[start, end], ...] of byte
   offsets for every top-level `name={` block. */
async function scanSections(save) {
  const size = save.size;
  const CH = 64 << 20, WIN = 512;
  const marks = [];
  const test = (u8, i, atEof) => {
    if (!isKeyStart(u8[i])) return null;
    let j = i + 1;
    while (j < u8.length && isKeyChar(u8[j])) j++;
    if (u8[j] !== 61 || u8[j + 1] !== 123) return null;
    let k = j + 2;
    while (k < u8.length && isSpace(u8[k])) k++;
    if (k < u8.length ? u8[k] !== 10 : !atEof) return null;
    return String.fromCharCode(...u8.subarray(i, j));
  };
  const check = async (u8, i, abs) => {
    if (!isKeyStart(u8[i])) return;
    let name;
    if (i + WIN <= u8.length) name = test(u8, i, false);
    else {
      const w = new Uint8Array(await save.slice(abs, Math.min(size, abs + WIN)).arrayBuffer());
      name = test(w, 0, abs + w.length >= size);
    }
    if (name) marks.push([name, abs]);
  };
  let lineStart = true;
  for (let base = 0; base < size; base += CH) {
    const u8 = new Uint8Array(await save.slice(base, Math.min(size, base + CH)).arrayBuffer());
    if (lineStart) await check(u8, 0, base);
    let p = 0;
    for (;;) {
      const nl = u8.indexOf(10, p);
      if (nl < 0) break;
      p = nl + 1;
      if (p < u8.length) await check(u8, p, base + p);
    }
    lineStart = u8[u8.length - 1] === 10;
    const frac = Math.min(1, (base + CH) / size);
    stage(`Reading the save… ${Math.round(frac * 100)}%`);
    progress(0.35 * frac);
  }
  const out = new Map();
  marks.forEach(([name, start], idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1][1] : size;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push([start, end]);
  });
  return out;
}

const readSpan = (save, start, end) => save.slice(start, end).text();

/* Split `<openKey>={ <id>={...} ... }` into Map id -> chunk text. */
function splitEntries(text, openKey) {
  let i = text.indexOf(openKey + "={");
  if (i < 0) return new Map();
  i += openKey.length + 2;
  const n = text.length;
  let depth = 1, inq = false, esc = false;
  const out = new Map();
  let cur = null, start = 0;
  const WS = (c) => c === 32 || c === 9 || c === 13 || c === 10;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (inq) {
      if (esc) esc = false;
      else if (c === 92) esc = true;
      else if (c === 34) inq = false;
      i++;
      continue;
    }
    if (c === 34) { inq = true; i++; continue; }
    if (c === 123) {
      if (depth === 1) {
        let j = i - 1;
        while (j > 0 && WS(text.charCodeAt(j))) j--;
        if (text[j] === "=") {
          let k = j - 1;
          while (k >= 0 && !(WS(text.charCodeAt(k)) || text[k] === "{" || text[k] === "}")) k--;
          cur = text.slice(k + 1, j);
          start = i + 1;
        }
      }
      depth++;
    } else if (c === 125) {
      depth--;
      if (depth === 1 && cur !== null) {
        out.set(cur, text.slice(start, i));
        cur = null;
      }
      if (depth === 0) break;
    }
    i++;
  }
  return out;
}

// ==========================================================================
// Extraction
// ==========================================================================
/* Per-country loan and bond figures (yearly rates as fractions, costs per month). */
function debtFigures(d, ec) {
  d = d || { loans: 0, loanP: 0, loanI: 0, foreign: 0, bonds: 0, bondP: 0, bondI: 0 };
  return {
    loans: d.loans, foreign_loans: d.foreign, loan_principal: d.loanP,
    loan_interest: d.loanP ? d.loanI / d.loanP : 0, loan_cost: d.loanI / 12,
    bonds: d.bonds, bond_principal: d.bondP,
    bond_interest: d.bondP ? d.bondI / d.bondP : 0, bond_cost: d.bondI / 12,
    debt_cost: (d.loanI + d.bondI) / 12,
    estate_debt: num(get(ec, "estate_debt")), foreign_debt: num(get(ec, "foreign_debt")),
    bond_debt: num(get(ec, "bond_debt")),
  };
}

async function extract(save, sections, topAi = 0) {
  // ---- metadata: who is the local player -------------------------------
  const metaTxt = (await readSpan(save, ...sections.get("metadata")[0])).slice(0, 200000);
  let m = metaTxt.match(/flag="([A-Z0-9]{2,3})=\{/);
  const youTag = m ? m[1] : null;
  const date = (metaTxt.match(/\n\tdate=([\d.]+)/) || [null, "?"])[1];
  // The world's age sits just after the metadata; it sets what unraised
  // levies would be armed as.
  const age = ((await save.slice(0, 4 << 20).text()).match(/\ncurrent_age=(\w+)/) || [null, "age_1_traditions"])[1];
  const version = (metaTxt.match(/\n\tversion="([^"]+)"/) || [null, "?"])[1];
  const playthrough = (metaTxt.match(/\n\tplaythrough_id="([^"]+)"/) || [null, null])[1];
  const mp = metaTxt.includes("multiplayer=yes");

  // ---- players ---------------------------------------------------------
  const players = new Map();
  for (const [start, end] of sections.get("played_country") || []) {
    const t = await readSpan(save, start, end);
    const cid = t.match(/\n\tcountry=(\d+)/);
    const nm = t.match(/\n\tname="([^"]*)"/);
    if (cid && !players.has(cid[1])) players.set(cid[1], nm ? nm[1] : "player");
  }

  // ---- countries -------------------------------------------------------
  stage("Reading countries…");
  progress(0.36);
  let ctext = await readSpan(save, ...sections.get("countries")[0]);
  const dbAt = ctext.indexOf("database={");
  if (dbAt < 0) throw new UserError("The save's countries section has no database.");
  const tags = new Map();
  for (const mm of ctext.slice(0, dbAt).matchAll(/\n\t\t(\d+)=([A-Za-z0-9_]+)/g)) tags.set(mm[1], mm[2]);
  let chunks = splitEntries(ctext, "database");
  ctext = null;

  const KEEP = ("country_type great_power_rank great_power_points capital " +
    "last_months_population last_months_tax_income last_months_subject_tax " +
    "last_months_foreign_building_income monthly_trade_balance " +
    "monthly_trade_value last_month_gold_income " +
    "total_produced max_manpower max_sailors researched_advances starting_technology_level " +
    "last_months_army_maintenance last_months_navy_maintenance institutions").split(" ");
  const BLK = ("score currency_data economy counters last_month_produced historical_population " +
    "historical_tax_base historical_economical_base owned_locations provinces " +
    "variables government timed_modifiers").split(" ");

  const countries = new Map();
  for (const [cid, chunk] of chunks) {
    let d;
    try {
      d = parse(chunk);
    } catch (e) {
      continue;
    }
    if (!isDict(d)) continue;
    const r = new Map([["id", cid], ["tag", tags.get(cid) || "?"]]);
    // The country's current map colour, e.g. `color=rgb { 104 107 106 }`.
    const cm = chunk.match(/\n\tcolor=(rgb|hsv360|hsv)\s*\{([^}]*)\}/);
    const rgb = cm ? colorFrom(cm[1], cm[2]) : null;
    if (rgb) r.set("color", hex(rgb));
    for (const k of KEEP) if (d.has(k)) r.set(k, d.get(k));
    for (const k of BLK) if (d.has(k)) r.set(k, d.get(k));
    r.set("n_owned", asList(r.get("owned_locations")).length);
    r.set("n_prov", asList(r.get("provinces")).length);
    r.delete("owned_locations");
    r.delete("provinces");
    const v = r.get("variables");
    r.delete("variables");
    r.set("kills", 0.0);
    if (isDict(v)) {
      for (const it of asList(get(v, "data"))) {
        if (isDict(it) && get(it, "flag") === "land_units_killed")
          r.set("kills", num(get(or(get(it, "data"), new Map()), "identity")) / VAR_SCALE);
      }
    }
    countries.set(cid, r);
  }
  chunks = null;

  // ---- locations: raw materials, development, tax ----------------------
  stage("Reading locations…");
  progress(0.5);
  const own = new Counter();
  const raw = new Map();
  const dev = new Counter(), tax = new Counter(), ptax = new Counter();
  const ctlSum = new Counter(), ctlWsum = new Counter();
  // Levies each pop type in a location can supply (thousands) - the
  // nearest thing the save has to a country's potential levies.
  const levyPot = new Counter();
  const levyPotNoble = new Counter(); // the nobles' share: they ride as cavalry
  const locRecs = [];
  if (sections.has("locations")) {
    let ltext = await readSpan(save, ...sections.get("locations")[0]);
    for (const part of ltext.split(/\n\t\t(?=\d+=\{)/)) {
      const o = part.match(/\n\t\t\towner=(\d+)/);
      if (!o) continue;
      const cid = o[1];
      own.add(cid, 1);
      const g = part.match(/\n\t\t\traw_material=(\w+)/);
      if (g) {
        if (!raw.has(cid)) raw.set(cid, new Counter());
        raw.get(cid).add(g[1], 1);
      }
      const dv = part.match(/\n\t\t\tdevelopment=([\d.]+)/);
      if (dv) dev.add(cid, parseFloat(dv[1]));
      const tx = part.match(/\n\t\t\ttax=([\d.]+)/);
      if (tx) tax.add(cid, parseFloat(tx[1]));
      const pt = part.match(/\n\t\t\tpossible_tax=([\d.]+)/);
      if (pt) ptax.add(cid, parseFloat(pt[1]));
      const ct = part.match(/\n\t\t\tcontrol=([\d.]+)/);
      if (ct) {
        ctlSum.add(cid, parseFloat(ct[1]));
        if (dv) ctlWsum.add(cid, parseFloat(ct[1]) * parseFloat(dv[1]));
      }
      for (const lv of part.matchAll(/\n\t\t\t\t\t(\w+)=\{[^{}]*?\n\t\t\t\t\t\tlevies=([\d.]+)/g)) {
        levyPot.add(cid, parseFloat(lv[2]));
        if (lv[1] === "nobles") levyPotNoble.add(cid, parseFloat(lv[2]));
      }
      // per-location detail for the interactive map
      const lid = part.match(/^(\d+)=\{/);
      if (lid) {
        const f = (re) => { const m = part.match(re); return m ? parseFloat(m[1]) : 0; };
        const pp = part.match(/\n\t\t\t\tpops=\{([^}]*)\}/);
        locRecs.push({
          lid: +lid[1], owner: cid,
          ctrl: (part.match(/\n\t\t\tcontroller=(\d+)/) || [0, cid])[1],
          rank: (part.match(/\n\t\t\trank=(\w+)/) || [0, ""])[1],
          raw: g ? g[1] : "",
          dev: dv ? parseFloat(dv[1]) : 0, control: ct ? parseFloat(ct[1]) : 0,
          tax: tx ? parseFloat(tx[1]) : 0, ptax: pt ? parseFloat(pt[1]) : 0,
          prosp: f(/\n\t\t\tprosperity=([\d.]+)/),
          inst: (part.match(/\n\t\t\tinstitutions=\{([^}]*)\}/) || [0, ""])[1],
          pops: pp ? pp[1].trim().split(/\s+/) : [],
        });
      }
    }
    ltext = null;
  }
  // location populations: the sum of their pops' sizes (thousands)
  if (locRecs.length && sections.has("population")) {
    stage("Counting people…");
    const size = new Map();
    const ptext = await readSpan(save, ...sections.get("population")[0]);
    for (const m of ptext.matchAll(/\n(\d+)=\{\n\ttype=\w+[^}]*?\n\tsize=([\d.]+)/g)) size.set(m[1], parseFloat(m[2]));
    for (const l of locRecs) {
      let s = 0;
      for (const id of l.pops) s += size.get(id) || 0;
      l.pop = s;
      delete l.pops;
    }
  }
  // Institution presence: the share of each country's people exposed to it
  // (a location's value is the percentage of its pops exposed).
  const instPop = new Map(), instTot = new Counter();
  for (const l of locRecs) {
    const p = l.pop || 0;
    instTot.add(l.owner, p);
    if (!instPop.has(l.owner)) instPop.set(l.owner, new Counter());
    for (const m of l.inst.matchAll(/(\w+)=([\d.]+)/g)) instPop.get(l.owner).add(m[1], p * Math.min(100, parseFloat(m[2])) / 100);
    delete l.inst;
  }
  // The institutions of each age, in order, and which have appeared yet.
  const institutions = [];
  if (sections.has("institution_manager")) {
    const itext = await readSpan(save, ...sections.get("institution_manager")[0]);
    for (const m of itext.matchAll(/\n\t\t(\w+)=\{([^}]*)\}/g))
      institutions.push({ key: m[1], active: /\bactive=yes/.test(m[2]) });
  }

  // ---- subunits: standing army / navy ----------------------------------
  stage("Counting armies…");
  progress(0.55);
  const army = new Counter(), levies = new Counter(), regulars = new Counter();
  const mercs = new Counter(), navy = new Counter(), subs = new Counter();
  // Navy in ships, split the same way as the army; morale and experience
  // are averaged per unit, weighted by strength (army) or per ship (navy).
  const navyLevies = new Counter(), navyRegulars = new Counter(), navyMercs = new Counter();
  const moraleW = { a: new Counter(), n: new Counter() }, expW = { a: new Counter(), n: new Counter() };
  const weight = { a: new Counter(), n: new Counter() };
  const companies = new Map(); // cid -> Set of hired mercenary company ids
  // Combat sums for military power (see militaryPower): regulars and
  // mercenaries together, raised levies apart; and men by unit class.
  const combat = new Map(); // cid -> {reg, raised, cls: {category: men}}
  const combatOf = (cid) => {
    if (!combat.has(cid)) combat.set(cid, { reg: emptySum(), raised: emptySum(), cls: byCat() });
    return combat.get(cid);
  };
  const unknownTypes = new Set();

  // Units belonging to a hired mercenary company. Available companies live
  // under mercenary_manager.pool; hired ones get a record in its database.
  const mercUnits = new Set();
  if (sections.has("mercenary_manager")) {
    const mtext = await readSpan(save, ...sections.get("mercenary_manager")[0]);
    const pAt = mtext.indexOf("\n\tpool={");
    const head = pAt >= 0 ? mtext.slice(0, pAt) : mtext;
    for (const ent of head.split(/\n(?=\d+=)/)) {
      if (ent.split("\n", 1)[0].includes("=none")) continue;
      for (const mm of ent.matchAll(/\b(?:unit|army|navy)=(\d+)/g)) mercUnits.add(mm[1]);
    }
  }

  if (sections.has("subunit_manager")) {
    const stext = await readSpan(save, ...sections.get("subunit_manager")[0]);
    for (const part of stext.split(/\n(?=\d+=\{)/)) {
      const o = part.match(/\n\towner=(\d+)/);
      const t = part.match(/\n\ttype=(\w+)/);
      if (!(o && t)) continue;
      const st = part.match(/\n\tstrength=([\d.]+)/);
      // strength=1 is never written: a missing value is a full-strength unit.
      const v = st ? parseFloat(st[1]) : 1.0;
      const cid = o[1];
      subs.add(cid, 1);
      // Hired mercenary units carry `mercenary=<company>` (1.3.11 saves);
      // older saves listed the company's units in mercenary_manager.
      const mc = part.match(/\n\tmercenary=(\d+)/);
      const u = part.match(/\n\tunit=(\d+)/);
      const isMerc = !!mc || !!(u && mercUnits.has(u[1]));
      const isLevy = !isMerc && part.includes("\n\tlevies=");
      if (mc) {
        if (!companies.has(cid)) companies.set(cid, new Set());
        companies.get(cid).add(mc[1]);
      }
      // Each naval subunit is one ship (`number=` is only its ordinal name).
      const kind = t[1].startsWith("n_") ? "n" : "a";
      const w = kind === "n" ? 1 : v;
      const mo = part.match(/\n\tmorale=([\d.]+)/), ex = part.match(/\n\texperience=([\d.]+)/);
      weight[kind].add(cid, w);
      if (mo) moraleW[kind].add(cid, parseFloat(mo[1]) * w);
      if (ex) expW[kind].add(cid, parseFloat(ex[1]) * w);
      if (kind === "n") {
        navy.add(cid, w);
        (isMerc ? navyMercs : isLevy ? navyLevies : navyRegulars).add(cid, w);
        continue;
      }
      army.add(cid, v);
      (isMerc ? mercs : isLevy ? levies : regulars).add(cid, v);
      let us = UNIT_STATS[t[1]];
      if (!us) { unknownTypes.add(t[1]); us = [1, 1, 1, "hi"]; }
      // experience cuts damage taken by up to half (LAND_EXPERIENCE_DAMAGE_REDUCTION)
      const xp = ex ? Math.min(1, parseFloat(ex[1])) : 0;
      const cs = combatOf(cid), sum = isLevy ? cs.raised : cs.reg;
      sum.o[us[3]] += v * us[0] * us[1];
      sum.h += v / (us[2] * (1 - 0.5 * xp));
      sum.men += v;
      cs.cls[us[3]] += v;
    }
  }
  if (unknownTypes.size) log("military power: unknown unit types counted as plain infantry: " + [...unknownTypes].join(", "));

  // ---- loans and bonds -------------------------------------------------
  // Each loan: amount (principal), interest (a yearly rate), month (months
  // left), borrower, and a lender when it's owed to another country rather
  // than to the borrower's own estates. Government bonds are marked
  // bond=yes and have no term. A country's debt totals are principal plus
  // the interest still due, so the monthly cost is principal x rate / 12.
  const debtOf = new Map(); // cid -> {loans, loanP, loanI, foreign, bonds, bondP, bondI}
  if (sections.has("loan_manager")) {
    const ltxt = await readSpan(save, ...sections.get("loan_manager")[0]);
    for (const part of ltxt.split(/\n(?=\d+=\{)/)) {
      const b = part.match(/\n\tborrower=(\d+)/), a = part.match(/\n\tamount=([\d.]+)/);
      if (!b || !a) continue;
      const amount = parseFloat(a[1]), rate = parseFloat((part.match(/\n\tinterest=([\d.]+)/) || [0, 0])[1]) || 0;
      if (!debtOf.has(b[1])) debtOf.set(b[1], { loans: 0, loanP: 0, loanI: 0, foreign: 0, bonds: 0, bondP: 0, bondI: 0 });
      const d = debtOf.get(b[1]);
      if (/\n\tbond=yes/.test(part)) { d.bonds++; d.bondP += amount; d.bondI += amount * rate; }
      else { d.loans++; d.loanP += amount; d.loanI += amount * rate; if (/\n\tlender=\d+/.test(part)) d.foreign++; }
    }
  }

  // ---- wars in progress: per-country losses ----------------------------
  const lost = new Map();
  let nWars = 0;
  if (sections.has("war_manager")) {
    const wtext = await readSpan(save, ...sections.get("war_manager")[0]);
    for (const mm of wtext.matchAll(/\n(\d+)=\{/g)) {
      const s = mm.index + mm[0].length;
      const nxt = wtext.indexOf("\n}", s);
      const body = wtext.slice(s, nxt > 0 ? nxt : wtext.length);
      if (!body.includes("all_history")) continue;
      let w;
      try {
        w = parse("{" + body);
      } catch (e) {
        continue;
      }
      if (!isDict(w) || !w.has("all")) continue;
      nWars++;
      for (const p of asList(w.get("all"))) {
        if (!isDict(p)) continue;
        const cid = get(p, "country");
        for (const h of asList(get(p, "all_history"))) {
          if (!isDict(h)) continue;
          let L = or(get(or(get(or(get(h, "joined"), new Map()), "losses"), new Map()), "losses"), new Map());
          if (!isDict(L)) continue;
          for (const [, vv] of L) {
            if (!isDict(vv)) continue;
            if (!lost.has(cid)) lost.set(cid, new Counter());
            for (const [cause, nn] of vv) lost.get(cid).add(cause, num(nn));
          }
        }
      }
    }
  }

  // ---- assemble rows ---------------------------------------------------
  const C = (cid) => countries.get(cid) || new Map();
  const cget = (c, k) => get(c, k);
  const dictOr = (x) => (isDict(x) && x.size ? x : new Map());
  function metric(cid, which) {
    const c = C(cid);
    const cd = dictOr(cget(c, "currency_data"));
    const ec = dictOr(cget(c, "economy"));
    switch (which) {
      case "pop": return num(cget(c, "last_months_population"));
      case "gold": return num(get(cd, "gold"));
      case "taxbase": return tax.val(cid);
      case "wealth": return ptax.val(cid);
      case "control": return own.val(cid) ? ctlSum.val(cid) / own.val(cid) : 0.0;
      case "dev": return dev.val(cid);
      case "econbase": {
        const h = or(cget(c, "historical_economical_base"), [0]);
        return num(Array.isArray(h) ? h[h.length - 1] : typeof h === "string" ? h[h.length - 1] : 0);
      }
      case "income": return num(get(ec, "income"));
      case "locations": return cget(c, "n_owned") || 0;
      case "produced": return num(cget(c, "total_produced"));
      case "trade": return num(cget(c, "monthly_trade_value"));
      case "army": return Math.max(levyPot.val(cid), levies.val(cid)) + regulars.val(cid) + mercs.val(cid);
      case "levies": return levies.val(cid);
      case "regulars": return regulars.val(cid);
      case "mercs": return mercs.val(cid);
      case "kills": return cget(c, "kills") || 0;
    }
    throw new Error("unknown metric " + which);
  }

  const METRICS = ["pop", "gold", "taxbase", "wealth", "control", "dev", "econbase",
    "income", "locations", "produced", "trade", "army", "levies",
    "regulars", "mercs", "kills"];
  const live = [...countries.values()].filter(
    (c) => get(c, "country_type") === "Real" && num(get(c, "last_months_population")) > 0);
  const ranks = {};
  for (const mname of METRICS) {
    const vals = new Map(live.map((c) => [c.get("id"), metric(c.get("id"), mname)]));
    const order = [...live].sort((a, b) => vals.get(b.get("id")) - vals.get(a.get("id")));
    ranks[mname] = new Map(order.map((c, i) => [c.get("id"), i + 1]));
  }

  let chosen = [...players.keys()];
  if (topAi) {
    const devs = new Map(live.map((c) => [c.get("id"), metric(c.get("id"), "dev")]));
    const extra = [...live].sort((a, b) => devs.get(b.get("id")) - devs.get(a.get("id")))
      .map((c) => c.get("id")).filter((id) => !players.has(id)).slice(0, topAi);
    chosen = chosen.concat(extra);
  }

  const toObj = (d, f) => {
    const o = {};
    if (isDict(d)) for (const [k, v] of d) o[k] = f(v);
    return o;
  };
  const rows = [];
  for (const cid of chosen) {
    const c = countries.get(cid);
    if (!c) continue;
    const cd = dictOr(get(c, "currency_data"));
    const ec = dictOr(get(c, "economy"));
    const ct = dictOr(get(c, "counters"));
    const sc = dictOr(get(dictOr(get(c, "score")), "score_rating"));
    const wl = lost.get(cid) || new Counter();
    const tag = c.get("tag");
    let ph = asList(get(c, "historical_population")).map((x) => num(x));
    if (!ph.length) ph = [metric(cid, "pop")];
    const rk = {};
    for (const mname of METRICS) rk[mname] = ranks[mname].has(cid) ? ranks[mname].get(cid) : null;
    rows.push({
      id: cid, tag, name: NAMES[tag] || tag, color: get(c, "color") || null,
      player: players.has(cid) ? players.get(cid) : "AI", is_player: players.has(cid),
      pop: metric(cid, "pop"), gold: metric(cid, "gold"),
      taxbase: metric(cid, "taxbase"), dev: metric(cid, "dev"),
      econbase: metric(cid, "econbase"),
      wealth: metric(cid, "wealth"), control: metric(cid, "control"),
      control_wtd: dev.val(cid) ? ctlWsum.val(cid) / dev.val(cid) : 0.0,
      income: num(get(ec, "income")), expense: num(get(ec, "expense")),
      debt: num(get(ec, "total_debt")), loan_capacity: num(get(ec, "loan_capacity")),
      ...debtFigures(debtOf.get(cid), ec),
      creditworthiness: num(get(ec, "creditworthiness")),
      coin_minting: num(get(ec, "coin_minting")),
      tax_income: num(get(c, "last_months_tax_income")),
      subject_tax_base: num(get(c, "last_months_subject_tax")),
      building_income: num(get(c, "last_months_foreign_building_income")),
      trade_value: num(get(c, "monthly_trade_value")),
      trade_balance: num(get(c, "monthly_trade_balance")),
      total_produced: num(get(c, "total_produced")),
      locations: Math.trunc(get(c, "n_owned") || 0), provinces: Math.trunc(get(c, "n_prov") || 0),
      _researched: isDict(get(c, "researched_advances"))
        ? [...get(c, "researched_advances")].filter(([k, v]) => v === "yes").map(([k]) => k) : null,
      _startLevel: c.has("starting_technology_level") ? num(get(c, "starting_technology_level"), null) : null,
      advances: Math.trunc(num(get(ct, "Advances"))), wars: Math.trunc(num(get(ct, "Wars"))),
      rebels: Math.trunc(num(get(ct, "Rebels"))),
      gp_rank: Math.trunc(num(get(c, "great_power_rank"), 999)),
      gp_points: num(get(c, "great_power_points")),
      score_place: Math.trunc(num(get(dictOr(get(c, "score")), "score_place"))),
      score: toObj(sc, (v) => num(v)),
      prestige: num(get(cd, "prestige")), stability: num(get(cd, "stability")),
      manpower: num(get(cd, "manpower")), max_manpower: num(get(c, "max_manpower")),
      army_tradition: num(get(cd, "army_tradition")),
      navy_tradition: num(get(cd, "navy_tradition")),
      govpower: num(get(cd, "government_power")), inflation: num(get(cd, "inflation")),
      // Army is the full strength if every levy were called up: potential
      // levies (which include any already raised) + regulars + mercenaries.
      army: Math.max(levyPot.val(cid), levies.val(cid)) + regulars.val(cid) + mercs.val(cid), navy: navy.val(cid),
      levies: levies.val(cid), regulars: regulars.val(cid),
      mercs: mercs.val(cid), merc_companies: (companies.get(cid) || new Set()).size,
      levies_potential: levyPot.val(cid),
      _combat: combatFigures(combat.get(cid), levyPot.val(cid), levies.val(cid), levyPotNoble.val(cid), age),
      ...institutionFigures(c, instPop.get(cid), instTot.val(cid), institutions),
      ...estimateMilitary(c, get(dictOr(get(c, "government")), "ruler")),
      army_morale: weight.a.val(cid) ? moraleW.a.val(cid) / weight.a.val(cid) : 0,
      army_exp: weight.a.val(cid) ? expW.a.val(cid) / weight.a.val(cid) : 0,
      navy_levies: navyLevies.val(cid), navy_regulars: navyRegulars.val(cid), navy_mercs: navyMercs.val(cid),
      navy_morale: weight.n.val(cid) ? moraleW.n.val(cid) / weight.n.val(cid) : 0,
      navy_exp: weight.n.val(cid) ? expW.n.val(cid) / weight.n.val(cid) : 0,
      sailors: num(get(cd, "sailors")), max_sailors: num(get(c, "max_sailors")),
      army_upkeep: num(get(c, "last_months_army_maintenance")),
      navy_upkeep: num(get(c, "last_months_navy_maintenance")),
      subunits: Math.trunc(subs.val(cid)), kills: get(c, "kills") || 0,
      war_battle: wl.val("Battle"), war_attrition: wl.val("Attrition"),
      goods: toObj(dictOr(get(c, "last_month_produced")), (v) => num(v)),
      raw: Object.fromEntries(raw.get(cid) || []),
      pop_hist: ph,
      tax_hist: asList(get(c, "historical_tax_base")).map((x) => num(x)),
      econ_hist: asList(get(c, "historical_economical_base")).map((x) => num(x)),
      ranks: rk,
    });
  }
  rows.sort((a, b) => a.gp_rank - b.gp_rank);

  // Every owned location, compactly, for the interactive map: owners (and
  // occupiers) are indexes into `owners`, ranks and raw materials into
  // their own lists. Numbers are rounded to keep the report small.
  const ownerIdx = new Map(), owners = [], ranksL = [], rawsL = [];
  const oi = (cid) => {
    if (!ownerIdx.has(cid)) {
      const c = countries.get(cid), tag = tags.get(cid) || "?";
      ownerIdx.set(cid, owners.length);
      owners.push([cid, tag, NAMES[tag] || tag, (c && c.get("color")) || null, players.has(cid) ? players.get(cid) : null]);
    }
    return ownerIdx.get(cid);
  };
  const li = (list, v) => { let i = list.indexOf(v); if (i < 0) { i = list.length; list.push(v); } return i; };
  const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000;
  const locs = locRecs.map((l) => [l.lid, oi(l.owner), l.ctrl === l.owner ? -1 : oi(l.ctrl), li(ranksL, l.rank),
    li(rawsL, l.raw), r1(l.dev), r3(l.control), r3(l.tax), r3(l.ptax), r3(l.prosp), r3(l.pop || 0)]);
  const locmap = { owners, ranks: ranksL, raws: rawsL, locs };
  Object.defineProperty(locmap, "ownerIdx", { value: ownerIdx, enumerable: false });
  await attachRulerTraits(rows, save, sections);
  for (const r of rows) {
    const cf = r._combat;
    delete r._combat;
    Object.assign(r, militaryPower(r, cf.reg, cf.raised, cf.unraised), { army_classes: cf.cls });
  }

  let worldPop = 0;
  for (const c of countries.values()) worldPop += num(get(c, "last_months_population"));
  const world = {
    n_countries: live.length,
    world_pop: worldPop,
    world_locations: own.total(),
    date, version, multiplayer: mp, you: youTag, playthrough,
    n_players: players.size, wars_live: nWars,
    save: save.name, institutions,
  };
  return { rows, world, locmap };
}

// ==========================================================================

async function resolveGame(src) {
  if (!src) return null;
  const fs = new GameFS(src);
  if (!(await fs.list("main_menu/common/coat_of_arms/coat_of_arms"))) return null;
  return fs;
}

// Anything that escapes the handler below: report it before the worker dies.
self.addEventListener("error", (e) => log(`worker error: ${e.message} (${e.lineno}:${e.colno})`));
self.addEventListener("unhandledrejection", (e) =>
  log("worker error: " + ((e.reason && e.reason.stack) || e.reason)));

self.onmessage = async (e) => {
  if (e.data && e.data.type === "fs") return fsReply(e.data);
  const { save, game, opts } = e.data;
  const t0 = performance.now();
  try {
    if (opts.buildPack) {
      const fs = await resolveGame(game);
      if (!fs) throw new UserError("That folder doesn't look like an EU5 install.");
      const pack = await buildPack(fs);
      progress(1);
      postMessage({ type: "done", data: pack }, [pack.png, pack.raster, ...Object.values(pack.flags)]);
      return;
    }
    stage("Checking the save…");
    await checkPlaintext(save);
    if (opts.peek) {
      // Just the in-game date and campaign, to put several saves in order.
      const head = await save.slice(0, 1 << 16).text();
      const date = (head.match(/\n\tdate=([\d.]+)/) || [null, null])[1];
      const playthrough = (head.match(/\n\tplaythrough_id="([^"]+)"/) || [null, null])[1];
      postMessage({ type: "done", data: { peek: true, date, playthrough } });
      return;
    }
    log(`reading ${save.name} (${Math.round(save.size / 1e6)} MB)`);
    const sections = await scanSections(save);
    const missing = ["metadata", "countries"].filter((k) => !sections.has(k));
    if (missing.length) throw new UserError(`Save is missing expected sections: ${missing.join(", ")}`);

    const data = await extract(save, sections, opts.top || 0);
    const w = data.world;
    log(`date ${w.date}  patch ${w.version}  ${w.n_players} player(s)  ` +
        `${w.n_countries} live countries  ${w.wars_live} wars in progress`);
    if (!data.rows.length) log("no player nations found in this save");

    const fs = await resolveGame(game);
    if (game && !fs) log("the linked folder doesn't look like an EU5 install - using the hosted game data instead");
    // Flags, map and the advance table come from the linked install when
    // there is one, else from the hosted game-data pack for the save's
    // version (or the newest pack).
    const anyPack = fs ? null : await choosePack(w.version);
    let advT = fs ? await loadAdvanceTable(fs) : null;
    if (!advT && anyPack) advT = await packFetch(anyPack, "advances.json", "json").catch(() => null);
    attachAdvanceStats(data.rows, advT);
    const starts = advT ? Object.fromEntries(Object.entries(advT.adv).filter(([, d]) => d[0] === 0 && d[3]).map(([k, d]) => [k, d[3]])) : null;
    attachAdvanceGains(data.rows, starts || (fs && (await loadStartingAdvances(fs))) || STARTING_ADVANCES);
    const pack = opts.flags || opts.map ? anyPack : null;
    if (pack) {
      log(`using ${pack.label}` + (pack.exact ? "" : ` (no pack for ${w.version})`));
      w.game_data = { source: "pack", version: pack.version, name: pack.name || null,
        build: pack.steam_build || null, matches: pack.exact };
    } else if (fs) {
      w.game_data = { source: "install", label: fs.label };
    }
    if (opts.flags && (fs || pack)) {
      stage("Drawing coats of arms…");
      if (fs) await attachFlags(data.rows, fs);
      else await attachFlagsFromPack(data.rows, pack);
    } else if (opts.flags) {
      log("flags: no game data available - skipping");
    }
    if (opts.map && (fs || pack)) {
      stage("Painting the map…");
      progress(0.75);
      let msrc = null;
      try {
        msrc = fs ? await mapSourceFromGame(fs) : await mapSourceFromPack(pack);
      } catch (err) {
        log("map: couldn't load the map data - " + err.message);
      }
      data.map = await buildMapData(data, sections, save, msrc);
    } else if (opts.map) {
      log("map: no game data available - skipping");
    }
    log(`done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    progress(1);
    postMessage({ type: "done", data });
  } catch (err) {
    if (!(err instanceof UserError) && err && err.stack) log(err.stack);
    postMessage({
      type: "error",
      code: err instanceof UserError ? err.code : "internal",
      message: err && err.message ? err.message : String(err),
    });
  }
};
