// An image the worker found faces in before its gender model loaded.
// The page must not apply that answer: applying it with no gender reads
// flags every face (both genders covered, and cached that way). It keeps
// the image covered and asks again once the model is in.
export function needsGenderWait(res) {
  return !!(res && res.genderPending && res.boxes && res.boxes.length);
}

// LOAD IT BEFORE THE FIRST FACE when the page will need it anyway. On the
// old Redmi (1136) the first screen of YouTube results in Women mode sat
// covered for 1.8-5.4s: the model was only asked for once a face was
// found, then fetched and compiled while every face waited. A declared
// gender on YouTube means faces, and every face needs this model.
export function wantsGenderPreload(mode, userGender, platform) {
  return mode === 'smart' && (userGender === 'man' || userGender === 'woman') && platform === 'youtube';
}

// THE NSFW ANSWER ONLY MATTERS WHEN NO FACE IS FLAGGED: the page applies
// `nsfw: !flagBoxes.length && res.nsfw`. So the worker may skip the
// classifier when its own read of the faces already keeps the image
// covered. Its copy of the bars can lag an OTA push, which is why the page
// re-checks (`mustRejudgeWithNsfw`) and never acts on a skip it disagrees
// with.
export function workerMaySkipNsfw(userGender, boxes, reads, genderPending, flagged) {
  if (!boxes || !boxes.length) return false;
  // Held for the gender model: this answer is never applied.
  if (genderPending) return true;
  // No reads: the page flags every face (presence-only).
  if (!reads || !reads.length) return true;
  return flagged(userGender, reads).length > 0;
}

// The worker skipped NSFW but the page's own verdict flags no face: that
// answer has no NSFW read in it and must not reveal anything. The image
// stays covered and is judged again with the classifier.
export function mustRejudgeWithNsfw(res, flagBoxes) {
  return !!(res && res.nsfwSkipped && !(flagBoxes && flagBoxes.length));
}
