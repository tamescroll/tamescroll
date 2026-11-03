// What the gaze pipeline runs in each launcher mode. Off runs nothing:
// the compulsory tier (handoff decision #1) that booted it there was
// dropped on his word 2026-10-28 ("if anyways we arent doing blur then
// no point of keeping it on"). With blur off every thumbnail flashed
// blurred while the NSFW model loaded and checked it, and "Nothing"
// promised no blur. Every picture runs nothing either (his 2026-10-28,
// "blur is enough"): its sheet already covers every image, and the NSFW
// check on top of it cost the old Redmi 41% janky scroll frames against
// 26% with no model. NSFW removal now runs only in the women/men modes.
// Pure data so the policy is unit-testable away from the DOM.

/**
 * @param {string|undefined} mode  window.__TS_GAZE_MODE
 * @returns {{boot:boolean, preBlur:boolean, textFilter:boolean,
 *            faceGender:boolean, nsfw:boolean, revealClears:boolean}}
 */
export function planForMode(mode) {
  if (mode === 'smart') {
    return {
      boot: true,
      preBlur: true,
      textFilter: true,
      faceGender: true,
      nsfw: true,
      revealClears: true,
    };
  }
  return {
    boot: false,
    preBlur: false,
    textFilter: false,
    faceGender: false,
    nsfw: false,
    revealClears: false,
  };
}

/**
 * ROTATING WINDOW OVER AN ORDERED LIST.
 *
 * A crop budget is a BUDGET, not a ranking. Taking the head of a
 * confidence-sorted list every pass gives the same members the whole
 * budget forever whenever the order is stable -- which is exactly what a
 * locked-off multi-person shot produces (gauntlet R24: six MoveNet
 * persons whose slot scores moved by less than 0.02 across 15 seconds,
 * so ranks 4-6 were never once read and stayed covered by blur-first).
 *
 * So the sort still decides ORDER and the cursor decides where the
 * window starts. Returns the window, the members left over, and the next
 * cursor -- pure, so the policy can be pinned without a DOM.
 *
 * Below the budget this is the identity: `take` is the whole list, `rest`
 * is empty and the cursor does not move. That is what keeps every
 * one-to-three-person round already scored bit-identical.
 *
 * @param {Array} list    already ordered by priority
 * @param {number} budget how many may be taken this pass
 * @param {number} cursor previous return value's `cursor` (0 to start)
 */
export function rotateBudget(list, budget, cursor) {
  var n = list ? list.length : 0;
  if (!(budget > 0) || n === 0) return { take: [], rest: list ? list.slice() : [], cursor: cursor || 0 };
  if (n <= budget) return { take: list.slice(), rest: [], cursor: cursor || 0 };
  var start = ((cursor || 0) % n + n) % n;
  var take = [];
  for (var i = 0; i < budget; i++) take.push(list[(start + i) % n]);
  var rest = [];
  for (var j = 0; j < n; j++) {
    if (take.indexOf(list[j]) === -1) rest.push(list[j]);
  }
  return { take: take, rest: rest, cursor: (start + budget) % n };
}
