const form = document.getElementById('form');
const input = document.getElementById('token');
const status = document.getElementById('status');

chrome.storage.local.get('token').then(({ token }) => {
  input.value = token ?? '';
  if (token) check();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = input.value.trim();
  if (!token) {
    await chrome.storage.local.remove('token');
    status.textContent = 'Token removed.';
    return;
  }
  await chrome.storage.local.set({ token });
  check();
});

async function check() {
  status.textContent = 'Checking…';
  const { status: code, data, error } = await chrome.runtime.sendMessage({ type: 'github', path: '/user' });
  if (error) status.textContent = error;
  else if (code === 200) status.textContent = `Saved. Commenting as ${data.login}.`;
  else status.textContent = "Saved, but GitHub didn't accept this token.";
}
