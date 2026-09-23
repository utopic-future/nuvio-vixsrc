// providers/vixsrc.js
// Nuvio local-scraper provider for https://vixsrc.to
//
// Nuvio calls: getStreams(tmdbId, mediaType, season, episode)
//   tmdbId    -> numeric TMDB id (Nuvio always passes TMDB, not IMDb)
//   mediaType -> "movie" | "tv"
//   season    -> season number (tv only)
//   episode   -> episode number (tv only)
//
// IMPORTANT: no async/await at the top level of this file - Hermes (the JS
// engine Nuvio's sandbox uses to load remote plugins) can only run this kind
// of dynamic code as plain Promise chains. Everything below uses .then()/.catch().

var VIXSRC_BASE = "https://vixsrc.to";

// While troubleshooting, leave this true: instead of silently returning an
// empty stream list on failure, the provider returns one fake "stream" entry
// whose title explains what went wrong (HTTP status, blocked by anti-bot
// page, markup not found, etc). That way you can see the real failure point
// directly in Nuvio's stream picker without needing console/log access.
// Once things work, flip this to false so failures just show as "no streams"
// again instead of a debug entry.
var DEBUG_MODE = true;

function debugStream(message) {
  return [
    {
      name: "VixSrc [DEBUG]",
      title: message,
      url: "https://example.invalid/vixsrc-debug",
      quality: "n/a",
      format: "m3u8",
      headers: COMMON_HEADERS
    }
  ];
}

var COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": VIXSRC_BASE + "/",
  "Origin": VIXSRC_BASE
};

// Build the embed page URL for a movie or an episode.
function buildEmbedUrl(tmdbId, mediaType, season, episode) {
  if (mediaType === "tv") {
    return VIXSRC_BASE + "/tv/" + tmdbId + "/" + season + "/" + episode;
  }
  return VIXSRC_BASE + "/movie/" + tmdbId;
}

// vixsrc's embed page contains an inline script block that looks roughly like:
//
//   window.masterPlaylist = {
//       type: 'video',
//       params: {
//           'token': '****************************',
//           'expires': '1699999999'
//       },
//       url: 'https://vixsrc.to/playlist/123456'
//   }
//   window.canPlayFHD = true
//
// We only need the token, expires and base playlist url out of that block,
// plus the canPlayFHD flag, so we isolate the block first and then run small
// regexes against just that substring (safer than matching the whole page).
function extractPlaylistInfo(html) {
  var markerIndex = html.indexOf("window.masterPlaylist");
  if (markerIndex === -1) {
    return null;
  }

  // Grab a generous chunk right after the marker - the object literal is
  // always small, so this comfortably contains the whole thing.
  var block = html.substring(markerIndex, markerIndex + 2000);

  var tokenMatch = block.match(/['"]?token['"]?\s*:\s*['"]([a-zA-Z0-9]+)['"]/);
  var expiresMatch = block.match(/['"]?expires['"]?\s*:\s*['"]?(\d+)['"]?/);
  var urlMatch = block.match(/url\s*:\s*['"]([^'"]+)['"]/);

  if (!tokenMatch || !expiresMatch || !urlMatch) {
    return null;
  }

  var canPlayFHDMatch = html.match(/window\.canPlayFHD\s*=\s*(true|false)/);

  return {
    token: tokenMatch[1],
    expires: expiresMatch[1],
    playlistUrl: urlMatch[1],
    canPlayFHD: canPlayFHDMatch ? canPlayFHDMatch[1] === "true" : false
  };
}

// Turn the extracted info into the final playable .m3u8 link(s).
function buildStreamUrls(info) {
  var separator = info.playlistUrl.indexOf("?") === -1 ? "?" : "&";
  var base =
    info.playlistUrl + separator + "token=" + info.token + "&expires=" + info.expires;

  var streams = [
    {
      name: "VixSrc",
      title: "Auto (HLS)",
      url: base + "&h=1",
      quality: "1080p",
      format: "m3u8",
      headers: COMMON_HEADERS
    }
  ];

  // Some vixsrc mirrors expose a higher-bitrate/FHD rendition behind an
  // extra query flag when canPlayFHD is true. Kept as a second, clearly
  // labeled option - if your account/region doesn't get a different
  // stream out of this, it's safe to ignore or remove this block.
  if (info.canPlayFHD) {
    streams.push({
      name: "VixSrc",
      title: "Auto (FHD, HLS)",
      url: base + "&h=1&b=1",
      quality: "2160p",
      format: "m3u8",
      headers: COMMON_HEADERS
    });
  }

  return streams;
}

function looksLikeChallengePage(html) {
  var needles = [
    "Just a moment",
    "cf-browser-verification",
    "cf_chl_",
    "Checking your browser",
    "Attention Required",
    "__cf_chl"
  ];
  for (var i = 0; i < needles.length; i++) {
    if (html.indexOf(needles[i]) !== -1) return true;
  }
  return false;
}

function getStreams(tmdbId, mediaType, season, episode) {
  var embedUrl = buildEmbedUrl(tmdbId, mediaType, season, episode);

  return fetch(embedUrl, { headers: COMMON_HEADERS })
    .then(function (response) {
      if (!response.ok) {
        var msg = "HTTP " + response.status + " from " + embedUrl;
        console.error("[VixSrc] " + msg);
        return DEBUG_MODE ? debugStream(msg) : [];
      }
      return response.text().then(function (html) {
        if (looksLikeChallengePage(html)) {
          var blockedMsg =
            "Blocked: vixsrc returned an anti-bot/challenge page instead of the real embed (len=" +
            html.length + ")";
          console.error("[VixSrc] " + blockedMsg);
          return DEBUG_MODE ? debugStream(blockedMsg) : [];
        }

        var info = extractPlaylistInfo(html);
        if (!info) {
          var hasMarker = html.indexOf("window.masterPlaylist") !== -1;
          var notFoundMsg = hasMarker
            ? "masterPlaylist marker found but token/expires/url regex didn't match - site markup likely changed"
            : "masterPlaylist marker not found at all (len=" + html.length +
              ") - id may not exist on vixsrc, or page structure changed";
          console.error("[VixSrc] " + notFoundMsg);
          return DEBUG_MODE ? debugStream(notFoundMsg) : [];
        }
        return buildStreamUrls(info);
      });
    })
    .catch(function (error) {
      var errMsg = "Fetch threw: " + error.message;
      console.error("[VixSrc] " + errMsg);
      return DEBUG_MODE ? debugStream(errMsg) : [];
    });
}

module.exports = { getStreams: getStreams };
