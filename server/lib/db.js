const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host:     process.env.MYSQL_HOST,
  user:     process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port:     parseInt(process.env.MYSQL_PORT) || 3306,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  dateStrings:        true,
  typeCast: function (field, next) {
    if (field.type === 'JSON') {
      const val = field.string();
      return val === null ? null : JSON.parse(val);
    }
    return next();
  },
});

module.exports = { pool };
