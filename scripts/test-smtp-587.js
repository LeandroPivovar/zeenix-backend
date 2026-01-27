const nodemailer = require('nodemailer');
require('dotenv').config();

async function testSMTP() {
    const smtpHost = 'smtpout.secureserver.net';
    const smtpPort = 587;
    const smtpUser = 'suporte@iazenix.com';
    const smtpPass = 'o4g*ppUA572(';

    console.log('Testing SMTP with:');
    console.log(`Host: ${smtpHost}`);
    console.log(`Port: ${smtpPort}`);
    console.log(`Secure: false (STARTTLS)`);
    console.log(`User: ${smtpUser}`);

    const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: false, // TLS requires secure: false
        auth: {
            user: smtpUser,
            pass: smtpPass,
        },
        tls: {
            rejectUnauthorized: false // Sometimes needed for GoDaddy
        },
        debug: true,
        logger: true
    });

    try {
        await transporter.verify();
        console.log('SMTP Connection verified successfully!');
    } catch (error) {
        console.error('SMTP Connection failed:', error);
    }
}

testSMTP();
