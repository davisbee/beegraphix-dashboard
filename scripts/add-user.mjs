// Adds the first admin (after that, admins add people on the Team page).
//
//   DASHBOARD_URL=https://... DASHBOARD_ADMIN_TOKEN=<the "*" token from SUBMIT_TOKENS> \
//     npm run add-user -- --email davis@beegraphix.com --name "Davis Slagle" --brand "*" --admin
//
// Prints a temporary password. The person picks their own the first time they sign in.
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const BASE = (process.env.DASHBOARD_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.DASHBOARD_ADMIN_TOKEN ?? "";
const email = opt("email");
const name = opt("name");
const brand = opt("brand") ?? "beegraphix";
if (!BASE || !TOKEN || !email || !name) {
  console.error('Usage: DASHBOARD_URL=... DASHBOARD_ADMIN_TOKEN=... npm run add-user -- --email <email> --name "<name>" [--brand beegraphix|rugbee|*] [--admin]');
  process.exit(1);
}
const res = await fetch(`${BASE}/api/users`, {
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ email, name, brand, role: args.includes("--admin") ? "admin" : "staff" }),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`[add-user] ${res.status} ${data.error ?? ""}`);
  process.exit(1);
}
console.log(`Added ${data.user.name} (${data.user.email}), ${data.user.role}, brand ${data.user.brand}.`);
console.log(`Temporary password: ${data.tempPassword}`);
console.log(`Sign in at ${BASE}`);
