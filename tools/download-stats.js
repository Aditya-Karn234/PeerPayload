#!/usr/bin/env node
// Snapshots the download counts of every release file and keeps their
// history, which GitHub doesn't: it only shows a running total per file.
// Run daily by .github/workflows/download-stats.yml, which stores the
// output on the `stats` branch.
//
//   node tools/download-stats.js <output dir>
//
// Env: GITHUB_REPOSITORY (owner/name, default this repo), GITHUB_TOKEN
// (optional; raises the API rate limit).
//
// Writes, in <output dir>:
//   downloads.csv   date,tag,asset,platform,downloads: one row per release
//                   file per day; the count is GitHub's running total
//   summary.json    per platform: total, last 7 and last 30 days, daily
//                   series; for the landing page
//   README.md       the same, readable
//
// These are downloads, not users or installs: a person can download twice,
// test and bot downloads count, and nobody is identified.

const fs = require("fs");
const path = require("path");

const REPO = process.env.GITHUB_REPOSITORY || "Aditya-Karn234/PeerPayload";
const out = process.argv[2];

if (!out) {
  console.error("usage: node tools/download-stats.js <output dir>");
  process.exit(2);
}

// Which app a release file is. Checksums and source archives aren't apps.
function platformOf(name) {
  if (/\.apk$/i.test(name)) return "Android";
  if (/windows.*\.exe$|\.exe$/i.test(name)) return "Windows";
  if (/\.AppImage$/i.test(name)) return "Linux";
  return null;
}

async function releases() {
  const all = [];

  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, {
      headers: {
        accept: "application/vnd.github+json",
        ...(process.env.GITHUB_TOKEN && { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
      },
    });

    if (!res.ok)
      throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

    const batch = await res.json();
    all.push(...batch);

    if (batch.length < 100)
      return all.filter((r) => !r.draft);
  }
}

function readCsv(file) {
  if (!fs.existsSync(file))
    return [];

  const [, ...lines] = fs.readFileSync(file, "utf8").trim().split("\n");

  return lines.filter(Boolean).map((line) => {
    const [date, tag, asset, platform, downloads] = line.split(",");
    return { date, tag, asset, platform, downloads: Number(downloads) };
  });
}

function writeCsv(file, rows) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.asset.localeCompare(b.asset));
  fs.writeFileSync(file, ["date,tag,asset,platform,downloads", ...sorted.map((r) => [r.date, r.tag, r.asset, r.platform, r.downloads].join(","))].join("\n") + "\n");
}

// Daily totals per platform: the sum, over that platform's files, of each
// file's latest known count on or before that day.
function series(rows, platform, days) {
  const mine = rows.filter((r) => r.platform === platform);
  const assets = [...new Set(mine.map((r) => r.asset))];

  return days.map((date) => {
    let total = 0;

    for (const asset of assets) {
      const known = mine.filter((r) => r.asset === asset && r.date <= date);
      if (known.length) total += known[known.length - 1].downloads;
    }

    return { date, total };
  });
}

async function main() {
  fs.mkdirSync(out, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const csv = path.join(out, "downloads.csv");
  const rows = readCsv(csv).filter((r) => r.date !== today); // a re-run replaces today's snapshot

  for (const release of await releases())
    for (const asset of release.assets) {
      const platform = platformOf(asset.name);
      if (platform) rows.push({ date: today, tag: release.tag_name, asset: asset.name, platform, downloads: asset.download_count });
    }

  writeCsv(csv, rows);

  const days = [...new Set(rows.map((r) => r.date))].sort();
  const at = (s, daysBack) => {
    const cutoff = new Date(Date.parse(today) - daysBack * 86400000).toISOString().slice(0, 10);
    const before = s.filter((p) => p.date <= cutoff);
    return before.length ? before[before.length - 1].total : 0;
  };

  const platforms = {};

  for (const platform of ["Android", "Windows", "Linux"]) {
    const s = series(rows, platform, days);
    const total = s.length ? s[s.length - 1].total : 0;
    // Never below zero: re-uploading a release file resets its count.
    platforms[platform] = { total, last7Days: Math.max(0, total - at(s, 7)), last30Days: Math.max(0, total - at(s, 30)), daily: s };
  }

  const summary = {
    updated: today,
    trackingSince: days[0],
    note: "Downloads of release files from GitHub, not users or installs. Counts include test and bot downloads. Recent-window numbers are only as old as the tracking.",
    total: Object.values(platforms).reduce((n, p) => n + p.total, 0),
    platforms,
  };

  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  const table = ["| Platform | Total | Last 7 days | Last 30 days |", "|---|---:|---:|---:|",
    ...Object.entries(platforms).map(([name, p]) => `| ${name} | ${p.total} | ${p.last7Days} | ${p.last30Days} |`),
    `| **All** | **${summary.total}** | ${Object.values(platforms).reduce((n, p) => n + p.last7Days, 0)} | ${Object.values(platforms).reduce((n, p) => n + p.last30Days, 0)} |`];

  fs.writeFileSync(path.join(out, "README.md"), `# PeerPayload Connect downloads

Updated ${today}, tracked daily since ${summary.trackingSince} by
\`.github/workflows/download-stats.yml\` on the \`main\` branch.

${table.join("\n")}

${summary.note} Last-7 and last-30-day figures cover only the days tracked so
far. Per file and per day: \`downloads.csv\`; for programs: \`summary.json\`.
`);

  console.log(`${today}: ${summary.total} downloads (${Object.entries(platforms).map(([n, p]) => `${n} ${p.total}`).join(", ")})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
