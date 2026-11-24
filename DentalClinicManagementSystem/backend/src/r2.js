const {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const configured = Boolean(
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET
);

let client;
function getClient() {
  if (!configured) throw new Error('Cloudflare R2 is not configured. Set the R2 environment variables.');
  if (!client) {
    const endpoint = process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    });
  }
  return client;
}

async function createUploadUrl({ key, contentType }) {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    ContentType: contentType
  });
  const expiresIn = Math.min(Number(process.env.R2_PRESIGN_SECONDS || 300), 900);
  return getSignedUrl(getClient(), command, { expiresIn });
}

async function createDownloadUrl(key) {
  const command = new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key });
  return getSignedUrl(getClient(), command, { expiresIn: 300 });
}

async function getObjectInfo(key) {
  return getClient().send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
}

module.exports = { createUploadUrl, createDownloadUrl, getObjectInfo, isConfigured: () => configured };
