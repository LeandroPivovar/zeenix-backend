const nodemailer = require('nodemailer');

async function testSMTP(port, secure) {
    const smtpHost = 'smtpout.secureserver.net';
    const smtpUser = 'suporte@iazenix.com';
    const smtpPass = 'o4g*ppUA572(';

    console.log(`\n--- Testing Port: ${port}, Secure: ${secure} ---`);

    const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: port,
        secure: secure,
        auth: {
            user: smtpUser,
            pass: smtpPass,
        },
        tls: {
            rejectUnauthorized: false
        },
        debug: false,
        logger: false
    });

    try {
        await transporter.verify();
        console.log(`✅ Success for Port ${port}, Secure ${secure}`);
        return true;
    } catch (error) {
        console.log(`❌ Failed for Port ${port}, Secure ${secure}: ${error.message}`);
        return false;
    }
}

async function runTests() {
    await testSMTP(465, true);
    await testSMTP(587, false);
    await testSMTP(80, false);
    await testSMTP(3535, false);
    await testSMTP(25, false);
}

runTests();
