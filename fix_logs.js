const fs = require('fs');
const path = 'c:/Users/Usuario/Documents/code/zeenix/backend/src/ai/strategies/apollo.strategy.ts';
try {
    let content = fs.readFileSync(path, 'utf8');
    console.log('Read ' + content.length + ' bytes');
    // Replace \` with `
    content = content.split('\\`').join('`');
    // Replace \${ with ${
    content = content.split('\\${').join('${');

    fs.writeFileSync(path, content);
    console.log('Fixed file. New length: ' + content.length);
} catch (e) {
    console.error(e);
}
