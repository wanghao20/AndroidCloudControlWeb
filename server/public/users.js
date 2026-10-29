const pageSize = 8;
let currentPage = 1;
let usersCache = [];

async function fetchUsers() {
  try {
    const resp = await fetch('/api/users', { headers: { 'x-admin-token': localStorage.getItem('adminToken') || '' } });
    if (!resp.ok) {
      const err = await resp.json();
      alert(err.message || '获取用户列表失败');
      return [];
    }
    return await resp.json();
  } catch (e) {
    alert('网络错误: ' + e.message);
    return [];
  }
}

function formatTime(ts) {
  if (ts === -1) return '永久';
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString();
}

function renderPagination(totalPages) {
  const pagination = document.getElementById('usersPagination');
  if (!pagination) return;
  if (totalPages <= 1) {
    pagination.innerHTML = '';
    return;
  }

  const prevDisabled = currentPage <= 1 ? 'disabled' : '';
  const nextDisabled = currentPage >= totalPages ? 'disabled' : '';

  pagination.innerHTML = `
    <button class="pager-btn" data-page="${currentPage - 1}" ${prevDisabled}>上一页</button>
    <span class="pager-info">第 ${currentPage} / ${totalPages} 页 · 共 ${usersCache.length} 条</span>
    <button class="pager-btn" data-page="${currentPage + 1}" ${nextDisabled}>下一页</button>
  `;

  pagination.querySelectorAll('.pager-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const page = Number(btn.dataset.page);
      if (!isNaN(page)) renderUsers(page);
    });
  });
}

async function renderUsers(page = currentPage) {
  const tbody = document.querySelector('#usersTable tbody');
  tbody.innerHTML = '<tr><td colspan="7">加载中...</td></tr>';
  const users = await fetchUsers();
  usersCache = Array.isArray(users) ? users : [];
  const totalPages = Math.max(1, Math.ceil(usersCache.length / pageSize));
  currentPage = Math.min(Math.max(1, page), totalPages);

  const start = (currentPage - 1) * pageSize;
  const pageUsers = usersCache.slice(start, start + pageSize);

  if (pageUsers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7">暂无用户</td></tr>';
    renderPagination(totalPages);
    return;
  }

  tbody.innerHTML = pageUsers.map((u) => {
    const isRoot = u.role === 'root';
    const actionHtml = isRoot
      ? '<span class="text-muted">根账号受保护</span>'
      : `
        <button class="table-btn edit-btn" data-id="${escapeHtml(u.id)}">编辑</button>
        <button class="table-btn delete-btn" data-id="${escapeHtml(u.id)}">删除</button>
      `;

    return `
      <tr>
        <td>${escapeHtml(u.id)}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.role)}</td>
        <td>${escapeHtml(String(u.maxDevices))}</td>
        <td>${formatTime(u.expireAt)}</td>
        <td>${u.disabled ? '是' : '否'}</td>
        <td class="table-actions">${actionHtml}</td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      if (!confirm('确定删除该账号？')) return;
      const resp = await fetch('/api/users/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': localStorage.getItem('adminToken') || '' },
        body: JSON.stringify({ id }),
      });
      const data = await resp.json();
      if (!resp.ok) { alert(data.message || '删除失败'); return; }
      renderUsers(currentPage);
    });
  });

  document.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      const pwd = prompt('输入新密码（留空则不修改）');
      const maxDevices = parseInt(prompt('最大设备数（-1 不限）', '5'), 10);
      const days = parseInt(prompt('有效天数（-1 永久）', '30'), 10);
      const expireAt = days > 0 ? Date.now() + days * 24 * 3600 * 1000 : -1;
      const disabled = confirm('是否禁用该账号？(确认=禁用)');
      const resp = await fetch('/api/users/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': localStorage.getItem('adminToken') || '' },
        body: JSON.stringify({ id, password: pwd || undefined, maxDevices: isNaN(maxDevices) ? undefined : maxDevices, expireAt, disabled }),
      });
      const data = await resp.json();
      if (!resp.ok) { alert(data.message || '更新失败'); return; }
      renderUsers(currentPage);
    });
  });

  renderPagination(totalPages);
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function openModal() {
  const modal = document.getElementById('createUserModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.getElementById('newUsername').focus();
}

function closeModal() {
  const modal = document.getElementById('createUserModal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.getElementById('createUserForm').reset();
}

function setupModalEvents() {
  const modal = document.getElementById('createUserModal');
  if (!modal) return;

  document.getElementById('addUserButton').addEventListener('click', openModal);
  document.getElementById('closeUserModal').addEventListener('click', closeModal);
  document.getElementById('cancelCreateUser').addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal || event.target.classList.contains('modal-backdrop')) {
      closeModal();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });
}

document.getElementById('createUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value.trim();
  const maxDevices = parseInt(document.getElementById('newMaxDevices').value, 10);
  const days = parseInt(document.getElementById('newDays').value, 10);
  if (!username || !password) { alert('用户名和密码必填'); return; }

  const resp = await fetch('/api/users/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': localStorage.getItem('adminToken') || '' },
    body: JSON.stringify({ username, password, maxDevices: isNaN(maxDevices) ? -1 : maxDevices, days: isNaN(days) ? -1 : days }),
  });
  const data = await resp.json();
  if (!resp.ok) { alert(data.message || '创建失败'); return; }
  alert('创建成功');
  closeModal();
  renderUsers(currentPage);
});

document.addEventListener('DOMContentLoaded', () => {
  setupModalEvents();
  renderUsers();
});
