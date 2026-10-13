#!/usr/bin/env node
/**
 * Prints a VAPID key pair for browser push notifications.
 *
 * Run it once - the keys identify *your* server to the browsers' push services
 * and must not change afterwards, or every existing subscription stops working.
 *
 *   npm run generate:vapid
 *
 * Set the two values on the host (Render → Environment) as VAPID_PUBLIC_KEY and
 * VAPID_PRIVATE_KEY, and optionally VAPID_SUBJECT to a mailto: address a push
 * service could reach you at if something went wrong. The private key is a
 * secret; the public key is handed to browsers and is safe to expose.
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log("Add these to your deployment environment (Render → Environment):\n");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com`);
console.log(
  "\nKeep VAPID_PRIVATE_KEY secret - it is what stops anyone sending pushes " +
    "that appear to come from your app. Do not change the pair once browsers have " +
    "subscribed, or they will silently stop receiving notifications."
);
