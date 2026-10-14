// Local copy of the old example.com page. The live site changed (no <h1>, extra
// paragraphs, injected link) and asks not to be relied on for testing.
import { createServer } from 'node:http';

const HTML = '<!doctype html><html><head><title>Example Domain</title></head><body><div>'
  + '<h1>Example Domain</h1>'
  + '<p>This domain is for use in illustrative examples in documents. You may use this domain in documentation examples without needing permission.</p>'
  + '<p><a href="https://www.iana.org/domains/example">More information...</a></p>'
  + '</div></body></html>';

/** Serve the page on 127.0.0.1 (random port). Returns { url, close }. */
export async function startExamplePage() {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((r) => srv.close(r)),
  };
}
