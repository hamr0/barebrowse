/**
 * blocklist.js — Ad/tracker URL patterns for CDP Network.setBlockedURLs.
 *
 * Curated by real-world frequency, not pulled wholesale from Peter Lowe /
 * EasyList. CDP does linear pattern matching per request, so 3,000-entry
 * lists add ~150ms cumulative cost on a typical page for ~5% extra coverage
 * (long-tail regional networks the agent rarely encounters). The set below
 * is ~120 patterns covering the trackers that actually show up in agent
 * traffic: Google/FB/Amazon/MS/Adobe ad+analytics, the major SaaS analytics
 * stacks (Segment/Amplitude/Mixpanel/HubSpot/Hotjar/FullStory/Heap/Mouseflow),
 * session-replay (LogRocket/Crazy Egg/Optimizely/VWO), content-recommendation
 * (Taboola/Outbrain/Criteo), and the consumer-pixel cluster (LinkedIn/Twitter/
 * TikTok/Snap/Pinterest/Reddit).
 *
 * Patterns are CDP-format globs: '*' matches any character run.
 *
 * To extend at runtime, pass connect({ blockUrls: [...] }) — your patterns
 * are merged with this default. To turn the default off entirely, pass
 * { blockAds: false }.
 */

export const DEFAULT_BLOCKLIST = [
  // --- Google ads + analytics (the single biggest cluster) ---
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googleadservices.com/*',
  '*://*.googletagservices.com/*',
  '*://*.googletagmanager.com/*',
  '*://*.google-analytics.com/*',
  '*://*.adservice.google.com/*',
  '*://pagead2.googlesyndication.com/*',
  '*://www.googleadservices.com/pagead/*',
  '*://ssl.google-analytics.com/*',
  '*://stats.g.doubleclick.net/*',

  // --- Facebook / Meta ---
  '*://connect.facebook.net/*',
  '*://*.facebook.com/tr*',          // Pixel (matches both /tr/... and /tr?...)
  '*://*.fbcdn.net/signals/*',

  // --- Amazon ads ---
  '*://*.amazon-adsystem.com/*',
  '*://aax.amazon-adsystem.com/*',
  '*://s.amazon-adsystem.com/*',

  // --- Microsoft (Bing ads + Clarity) ---
  '*://bat.bing.com/*',
  '*://*.clarity.ms/*',

  // --- Yandex ---
  '*://mc.yandex.ru/*',
  '*://an.yandex.ru/*',
  '*://yandex.ru/ads/*',

  // --- Adobe Marketing Cloud ---
  '*://*.omtrdc.net/*',
  '*://*.demdex.net/*',
  '*://*.everesttech.net/*',
  '*://*.2o7.net/*',
  '*://*.adobedtm.com/*',

  // --- LinkedIn ---
  '*://px.ads.linkedin.com/*',
  '*://snap.licdn.com/li.lms-analytics/*',

  // --- Twitter/X ---
  '*://analytics.twitter.com/*',
  '*://static.ads-twitter.com/*',
  '*://*.t.co/i/adsct*',

  // --- TikTok ---
  '*://analytics.tiktok.com/*',
  '*://business-api.tiktok.com/*',
  '*://*.tiktokcdn.com/tiktok/*',

  // --- Snap ---
  '*://tr.snapchat.com/*',
  '*://sc-static.net/scevent.min.js*',

  // --- Pinterest ---
  '*://ct.pinterest.com/*',
  '*://*.pinimg.com/ct/*',

  // --- Reddit ---
  '*://events.redditmedia.com/*',
  '*://www.redditstatic.com/ads/*',

  // --- Quantcast / ComScore / Chartbeat ---
  '*://pixel.quantserve.com/*',
  '*://*.quantcount.com/*',
  '*://*.scorecardresearch.com/*',
  '*://ping.chartbeat.net/*',
  '*://static.chartbeat.com/*',

  // --- Criteo / Taboola / Outbrain (content + retargeting) ---
  '*://*.criteo.com/*',
  '*://*.criteo.net/*',
  '*://cdn.taboola.com/*',
  '*://trc.taboola.com/*',
  '*://widgets.outbrain.com/*',
  '*://*.outbrain.com/utils/*',
  '*://amplify.outbrain.com/*',
  '*://log.outbrain.com/*',

  // --- Tealium / Marketo / Pardot / Salesforce marketing ---
  '*://tags.tiqcdn.com/*',
  '*://*.tealiumiq.com/*',
  '*://munchkin.marketo.net/*',
  '*://*.marketo.com/munchkin*',
  '*://pi.pardot.com/*',
  '*://*.exacttarget.com/cdn/*',

  // --- Yahoo / Verizon Media ---
  '*://*.yahoo.com/p.gif*',
  '*://ad.yieldmanager.com/*',
  '*://sp.analytics.yahoo.com/*',

  // --- RUM / front-end perf (debatable, but commonly noisy) ---
  '*://rum.pingdom.net/*',
  '*://bam.nr-data.net/*',
  '*://bam-cell.nr-data.net/*',
  '*://js-agent.newrelic.com/*',
  '*://*.browser-intake-datadoghq.com/*',
  '*://*.browser-intake-datadoghq.eu/*',

  // --- Session replay + heatmaps ---
  '*://*.hotjar.com/*',
  '*://*.hotjar.io/*',
  '*://*.fullstory.com/s/*',
  '*://*.fullstory.com/rec/*',
  '*://r.lr-ingest.io/*',
  '*://*.logrocket.io/*',
  '*://cdn.lr-ingest.com/*',
  '*://script.crazyegg.com/*',
  '*://cdn.mouseflow.com/*',
  '*://*.mouseflow.com/projects/*',

  // --- A/B testing ---
  '*://cdn.optimizely.com/*',
  '*://*.optimizely.com/event*',
  '*://dev.visualwebsiteoptimizer.com/*',
  '*://*.vwo.com/*',

  // --- Product analytics ---
  '*://api.segment.io/*',
  '*://cdn.segment.com/*',
  '*://*.segment.io/v1/*',
  '*://api.amplitude.com/*',
  '*://api2.amplitude.com/*',
  '*://cdn.amplitude.com/*',
  '*://api.mixpanel.com/*',
  '*://cdn.mxpnl.com/*',
  '*://*.heapanalytics.com/*',
  '*://heapanalytics.com/h*',
  '*://*.posthog.com/e/*',
  '*://*.posthog.com/decide/*',
  '*://*.posthog.com/static/array.js*',

  // --- Marketing automation ---
  '*://track.hubspot.com/*',
  '*://js.hs-scripts.com/*',
  '*://js.hs-analytics.net/*',
  '*://js.hsforms.net/*',

  // --- Customer messaging (these load chat widgets that bloat ARIA) ---
  '*://widget.intercom.io/*',
  '*://api-iam.intercom.io/messenger/*',
  '*://js.intercomcdn.com/*',
  '*://js.driftt.com/*',
  '*://event.api.drift.com/*',

  // --- Error reporters (Sentry kept off — agents may want to see errors) ---
  '*://sessions.bugsnag.com/*',
  '*://notify.bugsnag.com/*',

  // --- Mobile-measurement (increasingly served on web too) ---
  '*://*.appsflyer.com/*',
  '*://*.branch.io/*',
  '*://*.adjust.com/*',

  // --- Privacy-friendly analytics (still trackers from an agent POV) ---
  '*://static.cloudflareinsights.com/*',
  '*://*.matomo.cloud/*',

  // --- Misc widely-deployed ad networks ---
  '*://*.adnxs.com/*',                // AppNexus / Xandr
  '*://*.rubiconproject.com/*',
  '*://*.pubmatic.com/*',
  '*://*.openx.net/*',
  '*://*.casalemedia.com/*',
  '*://*.bidswitch.net/*',
  '*://*.adsrvr.org/*',               // The Trade Desk
  '*://*.media.net/*',
  '*://*.mediavoice.com/*',
  '*://*.serving-sys.com/*',          // Sizmek
  '*://*.smartadserver.com/*',
  '*://*.indexww.com/*',
  '*://*.mathtag.com/*',
  '*://*.tapad.com/*',
  '*://*.bluekai.com/*',              // Oracle Data Cloud
  '*://*.krxd.net/*',                 // Salesforce / Krux
];

/**
 * Resolve the effective blocklist from a page's blockAds/blockUrls options.
 * Single-sourced across engines (CDP applyBlocklist + BiDi applyFirefoxBlocklist)
 * so the merge/extend rule can't drift between them:
 *   - blockAds !== false → DEFAULT_BLOCKLIST plus any blockUrls (extend);
 *   - blockAds === false → only blockUrls (the default list is dropped);
 *   - neither → empty (blocking disabled).
 *
 * @param {object} [pageOpts]
 * @param {boolean} [pageOpts.blockAds] - false drops the default list.
 * @param {string[]} [pageOpts.blockUrls] - extra CDP-format globs.
 * @returns {string[]} the patterns to block (possibly empty).
 */
export function resolveBlocklistPatterns(pageOpts = {}) {
  return pageOpts.blockAds === false
    ? (pageOpts.blockUrls || [])
    : [...DEFAULT_BLOCKLIST, ...(pageOpts.blockUrls || [])];
}

/**
 * Compile CDP-format glob patterns into a single URL-matching predicate.
 *
 * CDP blocks natively via Network.setBlockedURLs, which does the glob matching
 * browser-side. WebDriver BiDi has no glob-capable equivalent — network.
 * addIntercept's urlPatterns reject '*' outright ("forbidden character *") and
 * can't express subdomain wildcards like *.doubleclick.net. So the Firefox
 * path intercepts *all* requests and matches each URL here, in-process, against
 * the same patterns — keeping the blocklist single-sourced across engines.
 *
 * Matches CDP's glob semantics: '*' = any run of characters, '?' = exactly
 * one character, whole-URL (anchored) match; every other character is literal.
 *
 * @param {string[]} patterns - CDP-format globs (e.g. DEFAULT_BLOCKLIST).
 * @returns {(url: string) => boolean} true when `url` matches any pattern.
 */
export function makeBlockMatcher(patterns) {
  const regexes = patterns.map((p) => {
    // Escape every regex metachar EXCEPT the two glob wildcards, then expand
    // them: '*' -> '.*', '?' -> '.'. (Escaping runs first so it never touches
    // the '.' / '*' we insert next.)
    const escaped = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp('^' + escaped + '$');
  });
  return (url) => regexes.some((re) => re.test(url));
}
