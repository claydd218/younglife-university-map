const params = new URLSearchParams(location.search);
if (params.has('error')) {
  document.getElementById('error').hidden = false;
}
