const crypto = require("crypto");

const ALGO = "sha256";
const ITERATIONS = 100000;

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.pbkdf2(password, salt, ITERATIONS, 64, ALGO, (err, derivedKey) => {
      if (err) reject(err);
      resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

function verifyPassword(password, storedHash) {
  return new Promise((resolve, reject) => {
    const [salt, key] = storedHash.split(":");
    crypto.pbkdf2(password, salt, ITERATIONS, 64, ALGO, (err, derivedKey) => {
      if (err) reject(err);
      resolve(key === derivedKey.toString("hex"));
    });
  });
}

module.exports = { hashPassword, verifyPassword };
