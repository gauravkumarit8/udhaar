let configWarningLogged = false;

function isConfigured(): boolean {
  return Boolean(process.env.MSG91_AUTH_KEY && process.env.MSG91_FLOW_ID);
}

/**
 * Sends the OTP code via MSG91's Flow (templated SMS) API. Your own `otps`
 * table still owns generation, expiry, and verification - this only handles
 * actually getting the code onto the person's phone.
 *
 * Requires a DLT-approved MSG91 Flow template with a variable named "OTP"
 * (adjust the `OTP` key below to match whatever your template calls it).
 *
 * No-ops (and logs a warning once) if MSG91_AUTH_KEY / MSG91_FLOW_ID aren't
 * set, so local dev keeps working without needing a real SMS account -
 * the OTP just won't actually be delivered, and the caller should fall
 * back to returning the code in the API response for dev convenience only.
 */
export async function sendOtpSms(mobile: string, code: string): Promise<{ sent: boolean; error?: string }> {
  if (!isConfigured()) {
    if (!configWarningLogged) {
      console.warn(
        "[sms] MSG91_AUTH_KEY / MSG91_FLOW_ID not set - OTPs will not be sent via SMS. " +
          "Set both to enable real delivery (https://msg91.com)."
      );
      configWarningLogged = true;
    }
    return { sent: false, error: "not_configured" };
  }

  try {
    const res = await fetch("https://control.msg91.com/api/v5/flow/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authkey: process.env.MSG91_AUTH_KEY!,
      },
      body: JSON.stringify({
        template_id: process.env.MSG91_FLOW_ID,
        short_url: "0",
        recipients: [
          {
            mobiles: `91${mobile}`,
            OTP: code,
          },
        ],
      }),
    });

    const data = await res.json();
    if (!res.ok || data.type === "error") {
      console.error("[sms] MSG91 send failed:", data);
      return { sent: false, error: data.message || "MSG91 request failed" };
    }

    return { sent: true };
  } catch (err) {
    console.error("[sms] Failed to send OTP SMS:", err);
    return { sent: false, error: "network_error" };
  }
}
