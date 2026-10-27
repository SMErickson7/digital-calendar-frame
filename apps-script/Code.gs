/**
 * Counter Calendar (v4): Google Apps Script backend.
 * Reads your Google calendars, the weather and your team logos, and serves the dashboard page.
 * Edit the CONFIG block to change which calendars appear and how.
 */

var CONFIG = {
  timeZone: 'America/New_York',

  // Where the weather is for (latitude and longitude of your town).
  weather: { latitude: 42.36, longitude: -71.06 },

  // Google Drive folder holding the team logos, named by code (CEL.svg, INT.svg, ...).
  // Open the folder in Drive: the ID is the last part of its URL.
  logoFolderId: 'YOUR_DRIVE_FOLDER_ID',

  // Your own plans: shown on the time grid. 'primary' is your main Google Calendar;
  // add other calendar IDs (Google Calendar > Settings > the calendar > Calendar ID).
  personal: [
    'primary'
  ],

  // Games and races. code = short tag and logo file name; label = name used in the ticker;
  // name = how the team appears in event titles (used to tell home from away);
  // bg/fg = block colors; league = shown when the calendar doesn't say the competition.
  // The two Google sports calendars below are public; add them in Google Calendar first
  // ("Browse calendars of interest" > Sports). For soccer, FotMob team calendars work well.
  sports: [
    { id: 'nba_-m-0bwjj_%42oston+%43eltics#sports@group.v.calendar.google.com', code: 'CEL', label: 'Celtics', name: 'Celtics', league: 'NBA', bg: '#007A33', fg: '#FFFFFF' },
    { id: 'nfl_-m-05g3b_%4eew+%45ngland+%50atriots#sports@group.v.calendar.google.com', code: 'PATS', label: 'Patriots', name: 'Patriots', league: 'NFL', bg: '#002244', fg: '#B0B7BC' },
    { id: 'YOUR_SOCCER_TEAM_CALENDAR_ID', code: 'INT', label: 'Inter', name: 'Inter', bg: '#010E80', fg: '#FFFFFF' },
    { id: 'YOUR_F1_CALENDAR_ID', code: 'F1', label: 'F1', name: 'F1', bg: '#E8002D', fg: '#FFFFFF', f1: true }
  ],

  // Holidays: shown as quiet tags in the side panel.
  holidays: [
    'en.usa#holiday@group.v.calendar.google.com'
  ],

  hideF1Practice: true, // keeps qualifying, sprint and the race
  personalDays: 5,      // 4 columns, plus 1 so a late-night window can run past midnight
  sideDays: 14          // days covered by the games panel
};

function doGet(e) {
  if (e && e.parameter && e.parameter.check) {
    var logos = Object.keys(JSON.parse(getLogos()));
    return ContentService.createTextOutput('Counter Calendar is deployed.\nLogos the dashboard can see: ' + (logos.join(', ') || 'none'));
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Counter Calendar')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ---------------- calendar data (refreshed every few minutes) ---------------- */

function getData() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('data10');
  if (hit) return hit;
  var json = JSON.stringify(buildData_());
  try { cache.put('data10', json, 300); } catch (e) { /* too large to cache, fine */ }
  return json;
}

function buildData_() {
  var now = new Date();
  var start = startOfDay_(now);
  var personalEnd = addDays_(start, CONFIG.personalDays);
  var sideEnd = addDays_(start, CONFIG.sideDays);

  var personal = [];
  CONFIG.personal.forEach(function (id) {
    var calName = calendarName_(id);
    readEvents_(id, start, personalEnd).forEach(function (ev) {
      personal.push({
        title: ev.getTitle() || '(No title)',
        start: ev.getStartTime().getTime(),
        end: ev.getEndTime().getTime(),
        allDay: ev.isAllDayEvent(),
        location: shortPlace_(ev.getLocation()),
        place: ev.getLocation() || '',        // full address, for the details panel
        desc: cleanDescription_(ev.getDescription()),
        cal: calName
      });
    });
  });

  var sports = [];
  CONFIG.sports.forEach(function (team) {
    readEvents_(team.id, start, sideEnd).forEach(function (ev) {
      var g = describeGame_(team, ev.getTitle(), ev.getDescription());
      if (!g) return;
      g.code = team.code; g.label = team.label || team.code; g.logo = team.logo || team.code; g.bg = team.bg; g.fg = team.fg;
      g.start = ev.getStartTime().getTime();
      g.end = ev.getEndTime().getTime();
      g.venue = venue_(ev.getLocation());
      g.allDay = ev.isAllDayEvent();
      sports.push(g);
    });
  });

  var holidays = [];
  CONFIG.holidays.forEach(function (id) {
    readEvents_(id, start, sideEnd).forEach(function (ev) {
      holidays.push({
        title: ev.getTitle(),
        date: Utilities.formatDate(ev.getAllDayStartDate ? ev.getAllDayStartDate() : ev.getStartTime(), CONFIG.timeZone, 'yyyy-MM-dd')
      });
    });
  });

  var byStart = function (a, b) { return a.start - b.start; };
  personal.sort(byStart);
  sports.sort(byStart);

  return { generated: now.getTime(), timeZone: CONFIG.timeZone, personal: personal, sports: sports, holidays: holidays };
}

/** Turns "⚽️ Inter - Fiorentina" into { title: "vs Fiorentina", sub: "Serie A" }. */
function describeGame_(team, rawTitle, description) {
  var t = String(rawTitle || '').replace(/^[^A-Za-z0-9(]+/, '').trim();
  // no spoilers: some feeds add the final score after a game, like "(1-0)" or "Inter 1 - 0 Shakhtar"
  t = t.replace(/\s*[\(\[]\s*\d+\s*[-:–]\s*\d+\s*[\)\]]/g, '').replace(/\s+\d+\s*[-:–]\s*\d+\s+/, ' - ').trim();
  var competition = lastTextLine_(description);

  if (team.f1) {
    var m = t.replace(/^F1:\s*/i, '').match(/^(.*?)\s*\((.*)\)\s*$/);
    var session = m ? m[1] : t, race = m ? m[2] : '';
    if (CONFIG.hideF1Practice && /\bFP\d\b|practice/i.test(session)) return null;
    return { title: race.replace(/Grand Prix/i, 'GP') || session, sub: 'Formula 1 · ' + session.replace(/^Grand Prix$/i, 'Race') };
  }

  var away = /\s@\s/.test(t);
  var parts = t.split(/\s+(?:-|–|v|vs\.?|@)\s+/i);
  if (parts.length === 2) {
    var a = parts[0].trim(), b = parts[1].trim();
    var name = team.name.toLowerCase();
    var aIsUs = a.toLowerCase().indexOf(name) !== -1 || name.indexOf(a.toLowerCase()) !== -1;
    // "A - B" / "A vs B": A is home. "A @ B": A is away at B.
    var home = away ? !aIsUs : aIsUs;
    if (away) return { title: aIsUs ? 'at ' + b : 'vs ' + a, sub: competition || team.league || '', ha: home ? 'H' : 'A' };
    return { title: aIsUs ? 'vs ' + b : 'at ' + a, sub: competition || team.league || '', ha: home ? 'H' : 'A' };
  }
  return { title: t, sub: competition || team.league || '' };
}

function lastTextLine_(desc) {
  var lines = String(desc || '').split(/\r?\n/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s && !/^https?:\/\//i.test(s) && s.length < 60; });
  return lines.length ? lines[lines.length - 1] : '';
}

/* ---------------- weather (refreshed every 15 minutes) ---------------- */

function getWeather() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('weather2');
  if (hit) return hit;
  var w = CONFIG.weather;
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + w.latitude + '&longitude=' + w.longitude +
    '&current=temperature_2m,weather_code,is_day' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset' +
    '&temperature_unit=fahrenheit&timezone=' + encodeURIComponent(CONFIG.timeZone) + '&forecast_days=7';
  var r = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
  var out = {
    temp: Math.round(r.current.temperature_2m),
    code: r.current.weather_code,
    isDay: r.current.is_day === 1,
    days: {}
  };
  r.daily.time.forEach(function (d, i) {
    out.days[d] = {
      hi: Math.round(r.daily.temperature_2m_max[i]), lo: Math.round(r.daily.temperature_2m_min[i]), code: r.daily.weather_code[i],
      sunrise: Utilities.parseDate(r.daily.sunrise[i], CONFIG.timeZone, "yyyy-MM-dd'T'HH:mm").getTime(),
      sunset: Utilities.parseDate(r.daily.sunset[i], CONFIG.timeZone, "yyyy-MM-dd'T'HH:mm").getTime()
    };
  });
  var json = JSON.stringify(out);
  cache.put('weather2', json, 900);
  return json;
}

/* ---------------- team logos (loaded once, cached for 6 hours) ---------------- */

function getLogos() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('logoIndex2');
  if (hit && hit !== '[]') {
    var keys = JSON.parse(hit), cached = cache.getAll(keys.map(function (k) { return 'logo_' + k; }));
    if (Object.keys(cached).length === keys.length) {
      var res = {};
      keys.forEach(function (k) { res[k] = cached['logo_' + k]; });
      return JSON.stringify(res);
    }
  }
  var logos = {};
  try {
    var files = DriveApp.getFolderById(CONFIG.logoFolderId).getFiles();
    while (files.hasNext()) {
      var f = files.next();
      var m = f.getName().match(/^([A-Za-z0-9]+)\.(svg|png|jpe?g|webp)$/i);
      if (!m) continue;
      var code = m[1].toUpperCase(), blob = f.getBlob(), type = blob.getContentType();
      var bytes;
      if (/svg/i.test(m[2])) {
        bytes = Utilities.newBlob(fixSvg_(blob.getDataAsString())).getBytes();
        type = 'image/svg+xml';
      } else {
        bytes = blob.getBytes();
      }
      logos[code] = 'data:' + type + ';base64,' + Utilities.base64Encode(bytes);
    }
  } catch (e) {
    console.warn('Could not read the logo folder: ' + e);
  }
  if (Object.keys(logos).length) { // never save an empty result, so a failed read is retried
    try {
      var put = {};
      Object.keys(logos).forEach(function (k) { put['logo_' + k] = logos[k]; });
      cache.putAll(put, 21600);
      cache.put('logoIndex2', JSON.stringify(Object.keys(logos)), 21600);
    } catch (e) { /* a logo too large to cache, fine */ }
  }
  return JSON.stringify(logos);
}

/** Makes an SVG scale to fit its badge: adds a viewBox if it only has a width and height. */
function fixSvg_(svg) {
  var open = svg.match(/<svg\b[^>]*>/i);
  if (!open) return svg;
  var tag = open[0];
  if (!/viewBox=/i.test(tag)) {
    var w = tag.match(/\swidth="([\d.]+)/i), h = tag.match(/\sheight="([\d.]+)/i);
    if (w && h) tag = tag.replace(/<svg\b/i, '<svg viewBox="0 0 ' + w[1] + ' ' + h[1] + '"');
  }
  tag = tag.replace(/\s(width|height)="[^"]*"/gi, '');
  return svg.replace(open[0], tag);
}

/* ---------------- helpers ---------------- */

function getCalendar_(id) {
  return id === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id);
}

function calendarName_(id) {
  try { var c = getCalendar_(id); return c ? c.getName() : ''; } catch (e) { return ''; }
}

/** Event notes as plain text: no HTML, no runaway length. */
function cleanDescription_(d) {
  if (!d) return '';
  var t = String(d)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(p|div|li|ul|ol)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > 1200 ? t.slice(0, 1200) + '...' : t;
}

/** "Olympiastadion Berlin, Olympischer Platz 3, Berlin, GER" -> "Olympiastadion Berlin, Berlin" */
function venue_(loc) {
  if (!loc) return '';
  var p = String(loc).split(',').map(function (x) { return x.trim(); });
  if (p.length >= 3) {
    var us = /^(USA|United States)$/i.test(p[p.length - 1]) && p.length >= 4;
    var city = us ? p[p.length - 3] : p[p.length - 2];   // US addresses end in "City, State, USA"
    return p[0] === city ? p[0] : p[0] + ', ' + city;
  }
  return p.join(', ');
}

function readEvents_(id, start, end) {
  try {
    var cal = getCalendar_(id);
    if (!cal) return [];
    return cal.getEvents(start, end).filter(function (ev) {
      var status = ev.getMyStatus && ev.getMyStatus();
      return status !== CalendarApp.GuestStatus.NO;
    });
  } catch (e) {
    console.warn('Could not read calendar ' + id + ': ' + e);
    return [];
  }
}

function shortPlace_(loc) {
  if (!loc) return '';
  var parts = String(loc).split(',').map(function (s) { return s.trim(); });
  // "132 Old River Rd, Suite 205, Lincoln, RI 02865" -> "Lincoln, RI"
  if (parts.length >= 3) {
    var town = parts[parts.length - 2];
    var state = parts[parts.length - 1].replace(/\s*\d{5}(-\d{4})?$/, '');
    if (/^[A-Z]{2}$/.test(state)) return town + ', ' + state;
    return town;
  }
  return parts.join(', ');
}

function startOfDay_(d) {
  return new Date(Utilities.formatDate(d, CONFIG.timeZone, "yyyy-MM-dd'T'00:00:00XXX"));
}

function addDays_(d, n) {
  return startOfDay_(new Date(d.getTime() + n * 86400000 + 3 * 3600000)); // pad past DST shifts
}

/** Run this once from the editor to grant access, then check the log. */
function testRun() {
  var data = buildData_();
  console.log('Personal: ' + data.personal.length + ', games: ' + data.sports.length + ', holidays: ' + data.holidays.length);
  data.sports.slice(0, 6).forEach(function (g) { console.log(g.code + ' | ' + g.title + ' | ' + g.sub); });
  console.log('Weather: ' + getWeather());
  console.log('Logos found: ' + Object.keys(JSON.parse(getLogos())).join(', '));
}

/** Run this from the editor after changing a logo in Drive (then reload the frame). */
function clearCache() {
  CacheService.getScriptCache().removeAll(['logoIndex2', 'data10', 'weather2']);
}
