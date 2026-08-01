// Bootstraps the first admin account. There's no self-registration or SSO
// in this tool, so *something* has to create the first login outside the
// normal admin-creates-users flow — this is that something.
//
// Usage: node src/scripts/createAdmin.js <username> <password>

require("dotenv").config();

const db = require("../db");
const { hashPassword } = require("../auth/hash");

async function main() {
  const [username, password] = process.argv.slice(2);

  if (!username || !password) {
    console.error("Usage: node src/scripts/createAdmin.js <username> <password>");
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const existing = await db.user.findUnique({ where: { username } });

  if (existing) {
    console.error(`User "${username}" already exists.`);
    process.exit(1);
  }

  const user = await db.user.create({
    data: { username, passwordHash: await hashPassword(password), role: "admin" },
  });

  console.log(`Created admin "${user.username}" (id ${user.id}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
