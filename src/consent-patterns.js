/**
 * consent-patterns.js — Shared cookie-consent detection data.
 *
 * The engine-agnostic half of consent handling: the multilingual regex sets
 * and dialog roles used to recognise a consent dialog and its "accept" button.
 * Both the CDP walker (consent.js) and the BiDi walker (consent-firefox.js)
 * import these so the language coverage is single-sourced — a new language or
 * pattern is added once and both engines get it.
 */

// Button text patterns that mean "accept all" / "I agree" across common languages.
// Order matters: more specific patterns first to avoid false positives.
export const ACCEPT_PATTERNS = [
  // English
  /\baccept\s*all\b/i,
  /\ballow\s*all\b/i,
  /\bagree\s*to\s*all\b/i,
  /\byes,?\s*i\s*agree\b/i,
  /\bi\s*agree\b/i,
  /\baccept\s*cookies?\b/i,
  /\ballow\s*cookies?\b/i,
  /\bgot\s*it\b/i,
  // Dutch
  /\balles\s*accepteren\b/i,
  /\balles\s*toestaan\b/i,
  /\baccepteren\b/i,
  /\bakkoord\b/i,
  // German
  /\balle\s*akzeptieren\b/i,
  /\ballem\s*zustimmen\b/i,
  /\balle\s*cookies?\s*akzeptieren\b/i,
  // French
  /\btout\s*accepter\b/i,
  /\baccepter\s*tout\b/i,
  /\bj['']accepte\b/i,
  // Spanish
  /\baceptar\s*todo\b/i,
  /\baceptar\s*todas?\b/i,
  // Italian
  /\baccetta\s*tutto\b/i,
  /\baccetto\b/i,
  // Portuguese
  /\baceitar\s*tudo\b/i,
  // Russian
  /принять\s*все/i,
  /принять/i,
  /согласен/i,
  // Ukrainian
  /прийняти\s*все/i,
  /прийняти/i,
  // Polish
  /zaakceptuj\s*wszystk/i,
  /akceptuj\s*wszystk/i,
  /zgadzam\s*się/i,
  // Czech
  /přijmout\s*vše/i,
  /souhlasím/i,
  // Turkish
  /tümünü\s*kabul\s*et/i,
  /kabul\s*et/i,
  /kabul\s*ediyorum/i,
  // Romanian
  /acceptă\s*tot/i,
  /accept\s*toate/i,
  // Hungarian
  /összes\s*elfogadás/i,
  /elfogad/i,
  // Greek
  /αποδοχή\s*όλων/i,
  /αποδέχομαι/i,
  // Swedish
  /acceptera\s*alla/i,
  /godkänn\s*alla/i,
  // Danish
  /accepter\s*alle/i,
  /acceptér\s*alle/i,
  // Norwegian
  /godta\s*alle/i,
  /aksepter\s*alle/i,
  // Finnish
  /hyväksy\s*kaikki/i,
  /hyväksyn/i,
  // Arabic
  /قبول\s*الكل/,
  /قبول\s*الجميع/,
  /موافق/,
  /قبول/,
  // Persian
  /پذیرش\s*همه/,
  /موافقم/,
  /پذیرش/,
  // Chinese (Simplified + Traditional)
  /全部接受/,
  /接受所有/,
  /接受全部/,
  /同意并继续/,
  /全部接受/,
  /接受/,
  /同意/,
  // Japanese
  /すべて受け入れ/,
  /すべて許可/,
  /同意する/,
  /同意します/,
  // Korean
  /모두\s*수락/,
  /모두\s*동의/,
  /동의합니다/,
  /수락/,
  // Vietnamese
  /chấp\s*nhận\s*tất\s*cả/i,
  /đồng\s*ý\s*tất\s*cả/i,
  /đồng\s*ý/i,
  // Thai
  /ยอมรับทั้งหมด/,
  /ยอมรับ/,
  // Hindi
  /सभी\s*स्वीकार/,
  /स्वीकार\s*करें/,
  /सहमत/,
  // Indonesian / Malay
  /terima\s*semua/i,
  /setuju/i,
  // Generic single-word fallbacks (only matched inside dialogs)
  /^accept$/i,
  /^agree$/i,
  /^ok$/i,
];

// Roles that indicate a consent dialog container.
export const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);

// Text patterns in dialog names/headings that confirm it's about consent.
export const CONSENT_DIALOG_HINTS = [
  /cookie/i,
  /consent/i,
  /privacy/i,
  /before\s*you\s*continue/i,
  /voordat\s*je\s*verdergaat/i,  // Dutch
  /bevor\s*du\s*fortf/i,         // German
  /avant\s*de\s*continuer/i,     // French
  /antes\s*de\s*continuar/i,     // Spanish / Portuguese
  /prima\s*di\s*continuare/i,    // Italian
  /zanim\s*przejdziesz/i,        // Polish
  /прежде\s*чем\s*продолжить/i,  // Russian
  /devam\s*etmeden\s*önce/i,     // Turkish
  /続行する前に/,                  // Japanese
  /继续前/,                        // Chinese Simplified
  /繼續前/,                        // Chinese Traditional
  /계속하기\s*전에/,                // Korean
  /trước\s*khi\s*tiếp\s*tục/i,   // Vietnamese
  /ملفات\s*تعريف\s*الارتباط/,    // Arabic: cookies
  /คุกกี้/,                        // Thai: cookies
];
