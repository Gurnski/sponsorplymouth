// Links shared before the site had several fundraisers pointed at the homepage:
// /?dare=DARE-K7QM and /#emma. Both belong to the Dartmoor dare board, so send
// them there before the homepage draws. Loaded in the head without defer on purpose.
(function () {
  var homeAnchors = ['', '#', '#main', '#featured', '#fundraisers'];
  var hasDare = /[?&]dare=/.test(location.search);
  if (hasDare || homeAnchors.indexOf(location.hash) === -1) {
    location.replace('/f/dartmoor' + (hasDare ? location.search : '') + location.hash);
  }
})();
