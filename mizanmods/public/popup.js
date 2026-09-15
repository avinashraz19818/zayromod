const popup = document.querySelector('#welcome');
document.querySelector('#open').addEventListener('click', () => {
  if (typeof popup.showModal === 'function') popup.showModal();
  else popup.setAttribute('open', '');
});
popup.querySelector('button').addEventListener('click', () => {
  if (typeof popup.close === 'function') popup.close();
  else popup.removeAttribute('open');
});
