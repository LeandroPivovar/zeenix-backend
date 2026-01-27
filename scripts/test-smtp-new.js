const nodemailer = require('nodemailer');
require('dotenv').config();

async function testSMTP() {
    const smtpHost = process.env.SMTP_HOST || 'smtpout.secureserver.net';
    const smtpPort = parseInt(process.env.SMTP_PORT || '465');
    const smtpSecure = process.env.SMTP_SECURE || 'ssl';
    const smtpUser = process.env.SMTP_USERNAME || 'suporte@iazenix.com';
    const smtpPass = process.env.SMTP_PASSWORD || 'o4g*ppUA572(';

    console.log('Testing SMTP with:');
    console.log(`Host: ${smtpHost}`);
    console.log(`Port: ${smtpPort}`);
    console.log(`Secure: ${smtpSecure === 'ssl'}`);
    console.log(`User: ${smtpUser}`);

    const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure === 'ssl',
        auth: {
            user: smtpUser,
            pass: smtpPass,
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
