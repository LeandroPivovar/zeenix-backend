const fs = require('fs');
const content = fs.readFileSync('.env.example', 'utf16le'); // Try utf16le
console.log(content);
