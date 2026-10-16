/**
 * Filling six one-digit boxes from whatever the person actually did.
 *
 * The login screen asks for a 6-digit code in six boxes, which is the right
 * shape for a thumb and the wrong shape for a clipboard. Two things happen all
 * the time and neither worked: pasting the whole code (which dropped five of
 * the six digits, because each box kept only `value.slice(-1)`) and letting the
 * phone autofill the SMS code into the first box (which arrives as one change
 * event carrying all six digits, and hit the same wall).
 *
 * Pure and separate from the component because the rules have edges - a paste
 * that starts in the middle, a shorter paste, a paste into a later box - and
 * they are much easier to state here than to click through.
 */

/** How many digits the code has. Six, as the API, the SMS and the UI all say. */
export const OTP_LENGTH = 6;

/**
 * Apply one incoming edit to the boxes.
 *
 * @param digits  the boxes as they are now
 * @param index   the box the edit happened in
 * @param incoming whatever the input event carried: "", "7", or a whole code
 */
export function applyOtpInput(digits: string[], index: number, incoming: string): string[] {
  const typed = incoming.replace(/\D/g, "");
  const next = [...digits];

  if (typed.length === 0) {
    // Backspace or clearing a box: empty just this one, so the rest of the code
    // the person already typed is not thrown away.
    next[index] = "";
    return next;
  }

  if (typed.length === 1) {
    next[index] = typed;
    return next;
  }

  // More than one digit means a paste or an autofill. A whole code always starts
  // at the first box regardless of which box received it - a code is read from
  // the start, and filling from the middle would silently use the wrong six
  // digits. A partial paste fills forward from where it landed.
  const from = typed.length >= OTP_LENGTH ? 0 : index;
  for (let i = 0; i < typed.length && from + i < OTP_LENGTH; i++) {
    next[from + i] = typed[i];
  }
  return next;
}

/** The code, if all six boxes are filled - otherwise null. */
export function otpValue(digits: string[]): string | null {
  if (digits.length !== OTP_LENGTH) return null;
  return digits.every((digit) => /^\d$/.test(digit)) ? digits.join("") : null;
}

/**
 * Where the cursor goes after an edit.
 *
 * An earlier empty box always wins - after a paste that started in the middle
 * or a backspace, that is where the next digit belongs. Once every box is
 * filled the code is complete (and being verified), so focus sits at the end
 * rather than jumping around under a finger that is done typing.
 */
export function nextOtpFocus(digits: string[]): number {
  const empty = digits.findIndex((digit) => digit === "");
  return empty !== -1 ? empty : OTP_LENGTH - 1;
}
