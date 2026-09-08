// Inspect what the lite page actually contains.
(async () => {
  const res = await fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent('Uber latest quarterly earnings'), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
      accept: 'text/html',
    },
  });
  const html = await res.text();
  // all anchor tags
  const anchors = html.match(/<a\s[^>]*>/g) ?? [];
  console.log('total anchors:', anchors.length);
  anchors.slice(0, 8).forEach((a) => console.log('  ', a.slice(0, 160)));
  // any links at all
  const hrefs = html.match(/href="[^"]{10,}"/g) ?? [];
  console.log('hrefs:', hrefs.length);
  hrefs.slice(0, 10).forEach((h) => console.log('  ', h.slice(0, 120)));
})();