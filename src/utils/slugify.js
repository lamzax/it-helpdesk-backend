// Vienkārša "slug" ģenerēšana no latviešu teksta -- izmanto, lai
// automātiski izveidotu unikālu tehnisko "code" kategorijai, kad admin
// panelī vairs neprasa to ievadīt manuāli (tikai redzamo nosaukumu).
const DIACRITICS_MAP = {
  ā: 'a', č: 'c', ē: 'e', ģ: 'g', ī: 'i', ķ: 'k', ļ: 'l', ņ: 'n',
  š: 's', ū: 'u', ž: 'z',
  Ā: 'a', Č: 'c', Ē: 'e', Ģ: 'g', Ī: 'i', Ķ: 'k', Ļ: 'l', Ņ: 'n',
  Š: 's', Ū: 'u', Ž: 'z',
};

function slugify(text) {
  const replaced = text.split('').map((ch) => DIACRITICS_MAP[ch] || ch).join('');
  return replaced
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'kategorija';
}

module.exports = { slugify };
