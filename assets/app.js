(async function () {
    // ==========================================
    // 1. 基础配置与工具函数
    // ==========================================
    const elApp = document.getElementById('app');
    const elUserName = document.getElementById('user-name');
    const elUserRole = document.getElementById('user-role');
    const elPageTitle = document.getElementById('page-title');

    // 【修改点 1】升级版本号，强制重置数据以生成管理员账号
    const dbKey = 'library-db-v6';

    const enc = new TextEncoder();

    // 简单的哈希函数 (用于密码加密)
    async function sha256(s) {
        const d = enc.encode(s);
        const h = await crypto.subtle.digest('SHA-256', d);
        return Array.from(new Uint8Array(h)).map(b => ('00' + b.toString(16)).slice(-2)).join('');
    }

    // 生成唯一ID
    function uid(prefix) {
        return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 8);
    }

    // 日期处理工具
    function today() { return new Date(); }
    function fmtDate(d) { return d.toISOString().split('T')[0]; }
    function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
    function parseDate(s) { const p = s.split('-'); return new Date(p[0], p[1] - 1, p[2]); }

    // HTML 模板构造器
    function h(htmlStr) {
        const temp = document.createElement('div');
        temp.innerHTML = htmlStr.trim();
        return temp.firstElementChild || temp;
    }

    // ==========================================
    // 2. 数据存储层 (Store)
    // ==========================================
    const Remote = { sb: null, enabled: false, init() { this.enabled = !!(window.supabase && window.SUPABASE_URL && window.SUPABASE_ANON_KEY); if (this.enabled && !this.sb) { this.sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY) } }, async pull() { if (!this.enabled) return null; const { data, error } = await this.sb.from('library_data').select('payload').eq('id', 'main').limit(1); if (error) return null; return data && data.length > 0 ? data[0].payload : null }, async push(payload) { if (!this.enabled) return; await this.sb.from('library_data').upsert({ id: 'main', payload, updated_at: new Date().toISOString() }) } };
    const Store = {
        data: null,

        async load() { Remote.init(); const remote = await Remote.pull(); if (remote) { this.data = remote; this.saveLocal(); return } const raw = localStorage.getItem(dbKey); if (raw) { try { this.data = JSON.parse(raw); if (!this.data.logs) this.data.logs = [] } catch (e) { await this.initData() } } else { await this.initData() } if (Remote.enabled) { await Remote.push(this.data) } },

        async initData() { this.data = { books: [], copies: [], readers: [], loans: [], reservations: [], fines: [], logs: [], settings: { finePerDay: 0.5, defaults: { student: { limit: 5, days: 30, renewMax: 1 }, staff: { limit: 10, days: 60, renewMax: 3 } } } }; await this.seed(); this.save() },

        // 【修改点 2】新增 seed 函数，生成默认管理员和测试数据
        async seed() {
            console.log("正在初始化默认数据...");
            const adminPass = await sha256(''); // 空密码的哈希

            // 1. 创建管理员和测试读者
            this.data.readers.push(
                {
                    id: 'admin_001', card: 'admin', name: '系统管理员', type: 'admin',
                    status: 'active', locked: false,
                    limits: { limit: 99, days: 999, renewMax: 99 },
                    passwordHash: adminPass,
                    createdAt: fmtDate(today())
                },
                {
                    id: 'rd_001', card: 'S1001', name: '测试学生', type: 'student',
                    status: 'active', locked: false,
                    limits: this.data.settings.defaults.student,
                    passwordHash: '', createdAt: fmtDate(today())
                }
            );

            // 2. 创建一本测试图书
            this.data.books.push({
                id: 'bk_001', isbn: '9787115546081', title: 'JavaScript高级程序设计',
                author: 'Matt Frisbie', category: 'TP312', press: '人民邮电出版社',
                createdAt: fmtDate(today())
            });

            // 3. 创建图书副本
            this.data.copies.push({
                id: 'cp_001', bookId: 'bk_001', barcode: 'B001',
                location: 'A-1-01', status: 'available'
            });
        },

        saveLocal() { localStorage.setItem(dbKey, JSON.stringify(this.data)) },
        save() { this.saveLocal(); if (Remote.enabled) Remote.push(this.data) },
        reset() { localStorage.removeItem(dbKey); localStorage.removeItem('lib_user_session'); location.reload() },

        // --- ID 生成器 ---
        nextBarcode() {
            const s = this.data.copies.map(x => x.barcode).filter(Boolean);
            if (s.length === 0) return 'B001';
            const n = Math.max(...s.map(x => Number(x.replace(/\D/g, '')) || 0));
            return 'B' + ('000' + (n + 1)).slice(-3);
        },
        nextCard() {
            const s = this.data.readers.map(x => x.card).filter(c => c.startsWith('S'));
            const n = s.length ? Math.max(...s.map(x => Number(x.slice(1)) || 0)) : 1000;
            return 'S' + (n + 1);
        },

        // --- 辅助查询 ---
        findReader(card) { return this.data.readers.find(r => r.card === card); },
        findReaderById(id) { return this.data.readers.find(r => r.id === id); },
        findBook(isbn) { return this.data.books.find(b => b.isbn === isbn); },
        findBookById(id) { return this.data.books.find(b => b.id === id); },
        findCopy(barcode) { return this.data.copies.find(c => c.barcode === barcode); },
        findCopyById(id) { return this.data.copies.find(c => c.id === id); },

        getLoans(rid) { return this.data.loans.filter(l => l.readerId === rid); }, // 修改：返回该读者所有历史记录，不仅是 borrowed
        getCopiesByBookId(bid) { return this.data.copies.filter(c => c.bookId === bid); },

        // --- 日志系统 ---
        addLog(action, msg) {
            const now = new Date();
            this.data.logs.unshift({
                id: uid('log'), time: now.toISOString(), action: action, msg: msg
            });
            const limit = new Date(); limit.setDate(limit.getDate() - 30);
            this.data.logs = this.data.logs.filter(l => new Date(l.time) > limit);
            this.save();
        }
    };

    // ==========================================
    // 3. 认证与路由 (Auth & Router)
    // ==========================================
    const AUTH_KEY = 'lib_user_session';

    const Auth = {
        user: JSON.parse(localStorage.getItem(AUTH_KEY)) || null,

        async login(card, pass) {
            const r = Store.findReader(card);
            if (!r) return { ok: false, msg: '用户不存在' };
            if (r.locked) return { ok: false, msg: '账号已锁定' };

            // 密码校验 (使用最原始的逻辑)
            if (r.passwordHash) {
                // 1. 如果密码哈希存在，则进行哈希比较
                const inputHash = await sha256(pass);

                if (inputHash !== r.passwordHash) {
                    return { ok: false, msg: '密码错误' };
                }
            } else {
                // 2. 如果密码哈希为空 (新用户状态)，只允许空密码登录
                if (pass.length > 0) {
                    return { ok: false, msg: '新用户首次登录请直接点击登录，系统会强制您设置密码。' };
                }
            }

            this.user = r;
            localStorage.setItem(AUTH_KEY, JSON.stringify(r));
            this.updateUI();
            if (r.type !== 'admin') {
                const loans = Store.data.loans.filter(l => l.readerId === r.id && l.status === 'borrowed');
                const now = today();
                const soon = addDays(now, 3);
                const overdueCount = loans.filter(l => parseDate(l.dueDate) < now).length;
                const soonCount = loans.filter(l => {
                    const d = parseDate(l.dueDate);
                    return d >= now && d <= soon;
                }).length;
                if (overdueCount > 0 || soonCount > 0) {
                    alert(`提醒：您有 ${overdueCount} 本已超期未还，${soonCount} 本将在3天内到期，请及时处理`);
                }
            }
            return { ok: true };
        },

        isLoggedIn() { return this.user !== null; },

        logout() {
            this.user = null;
            localStorage.removeItem(AUTH_KEY);
            location.reload();
        },

        updateUI() {
            if (elUserName) elUserName.textContent = this.user ? this.user.name : '未登录';
            if (elUserRole) elUserRole.textContent = this.user ? (this.user.type === 'admin' ? '管理员' : '读者') : '访客';
        }
    };

    const Router = {
        init() {
            Auth.updateUI();
            window.addEventListener('hashchange', () => this.route());
            this.route();
        },
        route() {
            const hash = location.hash.slice(1) || 'dashboard';

            // 1. 未登录拦截
            if (!Auth.user && hash !== 'login') {
                const sidebar = document.querySelector('.sidebar');
                if (sidebar) sidebar.style.display = 'none';
                renderLogin();
                return;
            }

            // 2. 强制修改密码拦截
            // 如果已登录，且不是管理员，且密码哈希为空（说明是新用户），强制跳转到 force-pwd
            if (Auth.user && Auth.user.type !== 'admin' && Auth.user.passwordHash === '' && hash !== 'force-pwd') {
                location.hash = '#force-pwd';
                return; // 停止执行后续逻辑
            }

            // 3. 侧边栏显示控制
            const sidebar = document.querySelector('.sidebar');
            // 如果在登录页 或 强制改密页，隐藏侧边栏
            if (hash === 'login' || hash === 'force-pwd') {
                if (sidebar) sidebar.style.display = 'none';
            } else if (Auth.user && sidebar) {
                sidebar.style.display = 'flex';
            }

            // 4. 导航菜单高亮
            document.querySelectorAll('.nav-item').forEach(el => {
                el.classList.toggle('active', el.getAttribute('href') === '#' + hash);
            });

            // 5. 路由分发
            switch (hash) {
                case 'login': renderLogin(); break;
                case 'force-pwd': renderForceChangePassword(); break; // 【新增】注册新页面
                case 'dashboard': renderDashboard(); break;
                case 'catalog': renderCatalog(); break;
                case 'borrow': renderBorrow(); break;
                case 'search': renderSearch(); break;
                case 'readers': renderReaders(); break;
                case 'personal': renderPersonal(); break;
                case 'stats': renderStats(); break;
                case 'settings': renderSettings(); break;
                case 'reports': renderReports(); break;
                default: renderDashboard();
            }
        }
    };

    // ==========================================
    // 4. 页面渲染函数 (Views)
    // ==========================================

    function renderLogin() {
        if (elPageTitle) elPageTitle.textContent = '系统登录';
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) sidebar.style.display = 'none';

        // 构造登录界面 HTML
        const dom = h(`
        <div style="display:flex;justify-content:center;align-items:center;height:80vh;">
            <div class="card" style="width:380px;padding:30px;">
                <div style="text-align:center;margin-bottom:25px;">
                    <h2 style="margin:0;justify-content:center;border:none;">欢迎登录</h2>
                    <p style="color:#666;font-size:14px;margin-top:5px;">智慧图书馆管理系统</p>
                </div>

                <div style="display:flex; background:#f1f5f9; padding:4px; border-radius:8px; margin-bottom:20px;">
                    <label id="tab-admin" style="flex:1; text-align:center; padding:8px; cursor:pointer; border-radius:6px; font-size:14px; transition:all 0.2s; font-weight:500;">
                        <input type="radio" name="auth-role" value="admin" style="display:none" checked> 管理员
                    </label>
                    <label id="tab-reader" style="flex:1; text-align:center; padding:8px; cursor:pointer; border-radius:6px; font-size:14px; transition:all 0.2s; color:#64748b;">
                        <input type="radio" name="auth-role" value="reader" style="display:none"> 读者
                    </label>
                </div>

                <form class="form" id="login-form">
                    <div>
                        <label>账号 / 证号</label>
                        <input id="acc" placeholder="请输入管理员账号 (默认: admin)" value="admin">
                    </div>
                    <div>
                        <label>密码</label>
                        <input type="password" id="pwd" placeholder="请输入密码 (默认: 空)">
                    </div>
                    <button type="submit" style="width:100%;margin-top:10px;height:40px;">立即登录</button>
                </form>
                <div style="text-align:center;margin-top:20px;">
                    <button class="btn-text" id="btn-reset-data" style="font-size:12px;color:#999;">重置演示数据</button>
                </div>
            </div>
        </div>
        `);

        elApp.innerHTML = ''; elApp.appendChild(dom);

        // --- 交互逻辑 ---
        const tabAdmin = document.getElementById('tab-admin');
        const tabReader = document.getElementById('tab-reader');
        const inpAcc = document.getElementById('acc');
        const inpPwd = document.getElementById('pwd');

        // 样式激活状态辅助函数
        const setActive = (isAdmin) => {
            const activeStyle = 'background:#fff; color:#4f46e5; box-shadow:0 1px 3px rgba(0,0,0,0.1);';
            const inactiveStyle = 'background:transparent; color:#64748b; box-shadow:none;';

            tabAdmin.style.cssText = tabAdmin.style.cssText.split(';')[0] + '; ' + (isAdmin ? activeStyle : inactiveStyle);
            tabReader.style.cssText = tabReader.style.cssText.split(';')[0] + '; ' + (!isAdmin ? activeStyle : inactiveStyle);

            // 切换提示文案和默认值（为了演示方便）
            if (isAdmin) {
                inpAcc.placeholder = "请输入管理员账号 (默认: admin)";
                inpAcc.value = 'admin';
            } else {
                inpAcc.placeholder = "请输入读者证号 (如: S1001)";
                inpAcc.value = 'S1001';
            }
            inpPwd.value = ''; // 切换身份清空密码
        };

        // 初始化样式
        setActive(true);

        // 绑定点击事件
        tabAdmin.onclick = () => setActive(true);
        tabReader.onclick = () => setActive(false);

        // --- 提交逻辑 ---
        document.getElementById('login-form').onsubmit = async (e) => {
            e.preventDefault();

            // 获取当前选中的身份
            const selectedRole = document.querySelector('input[name="auth-role"]:checked').value;
            const c = inpAcc.value.trim();
            const p = inpPwd.value.trim();

            const res = await Auth.login(c, p);

            if (res.ok) {
                // 【新增】校验登录的账号类型是否匹配选中的身份
                const userType = Auth.user.type; // 'admin' 或 'student'/'staff'

                // 1. 如果选了管理员，但账号不是 admin
                if (selectedRole === 'admin' && userType !== 'admin') {
                    Auth.logout(); // 立即登出
                    alert('登录失败：该账号不是管理员账号，请切换到“读者”身份登录。');
                    return;
                }

                // 2. 如果选了读者，但账号是 admin
                if (selectedRole === 'reader' && userType === 'admin') {
                    Auth.logout(); // 立即登出
                    alert('登录失败：这是管理员账号，请切换到“管理员”身份登录。');
                    return;
                }

                if (sidebar) sidebar.style.display = 'flex';
                location.hash = '#dashboard';
                Router.route();
            } else {
                alert(res.msg);
            }
        };

        document.getElementById('btn-reset-data').onclick = () => {
            if (confirm('确定要清空所有数据并重置吗？')) Store.reset();
        };
    }

    function renderDashboard() {
        if (elPageTitle) elPageTitle.textContent = '工作台概览';
        const s = Store.data;
        const borrowing = s.loans.filter(l => l.status === 'borrowed').length;
        const overdue = s.loans.filter(l => l.status === 'borrowed' && parseDate(l.dueDate) < today()).length;

        const dom = h(`
      <div class="grid">
        <div class="card stat-card" style="grid-column:span 3">
          <div class="stat-label">馆藏图书</div>
          <div class="stat-value">${s.books.length}</div>
        </div>
        <div class="card stat-card" style="grid-column:span 3">
          <div class="stat-label">读者总数</div>
          <div class="stat-value">${s.readers.length}</div>
        </div>
        <div class="card stat-card" style="grid-column:span 3;border-left-color:var(--warning)">
          <div class="stat-label">当前借出</div>
          <div class="stat-value">${borrowing}</div>
        </div>
        <div class="card stat-card" style="grid-column:span 3;border-left-color:var(--danger)">
          <div class="stat-label">超期未还</div>
          <div class="stat-value" style="color:var(--danger)">${overdue}</div>
        </div>

        <div class="card" style="grid-column:span 12">
           <h2>快捷入口</h2>
           <div class="row">
             <button onclick="location.hash='borrow'">📚 借还办理</button>
             <button onclick="location.hash='catalog'">➕ 新书入库</button>
             <button onclick="location.hash='readers'">👤 读者注册</button>
             <button id="btn-main-logout" class="danger" style="margin-left:auto">退出系统</button>
           </div>
        </div>
      </div>
    `);
        elApp.innerHTML = ''; elApp.appendChild(dom);
        document.getElementById('btn-main-logout').onclick = () => Auth.logout();
        const topLogout = document.getElementById('logout-btn');
        if (topLogout) topLogout.onclick = () => Auth.logout();
    }

    function renderCatalog() {
        if (elPageTitle) elPageTitle.textContent = '图书编目';
        if (Auth.user.type !== 'admin') {
            elApp.innerHTML = `
            <div class="card" style="text-align: center; padding: 50px; color: #666;">
                <h2 style="color: #e53e3e; margin-bottom: 15px;">🚫 权限不足</h2>
                <p>只有 <strong>系统管理员</strong> 才有权限进行操作。</p>
            </div>`;
            return;
        }
        const dom = h(`
      <div class="grid">
        <div class="card" style="grid-column:span 5">
          <h2 id="form-title">录入新书</h2>
          <form class="form" id="book-form">
            <input type="hidden" id="edit-id">
            <label>ISBN</label><input id="isbn" required>
            <label>书名</label><input id="title" required>
            <label>作者</label><input id="author">
            <label>分类号</label><input id="cat">
            <label>出版社</label><input id="press">
            <div class="row" style="margin-top:10px;">
                <button type="submit" id="btn-save" style="flex:1">保存图书信息</button>
                <button type="button" id="btn-cancel" class="secondary" style="display:none;">取消修改</button>
            </div>
          </form>
        </div>
        <div class="card" style="grid-column:span 7">
          <h2>添加副本 / 最近入库</h2>
          <div class="row" style="margin-bottom:15px;padding-bottom:15px;border-bottom:1px solid #eee;">
               <input id="cp-isbn" placeholder="输入ISBN添加副本" style="width:180px">
               <input id="cp-loc" placeholder="架位 (如A-1)" style="width:120px">
               <input id="cp-count" type="number" value="1" style="width:60px">
               <button id="btn-add-copy" class="secondary">添加副本</button>
          </div>
          <div class="table-container">
            <table class="table">
              <thead><tr><th>书名</th><th>ISBN</th><th>副本数</th><th>操作</th></tr></thead>
              <tbody id="book-list"></tbody>
            </table>
          </div>
        </div>
      </div>
    `);
        elApp.innerHTML = ''; elApp.appendChild(dom);

        const updateList = () => {
            const list = Store.data.books.slice(-6).reverse();
            document.getElementById('book-list').innerHTML = list.map(b => {
                const cps = Store.data.copies.filter(c => c.bookId === b.id);
                return `<tr>
                    <td>${b.title}</td><td>${b.isbn}</td><td>${cps.length}</td>
                    <td>
                        <button class="btn-text" onclick="window.editBook('${b.id}')">✏️ 修改</button>
                        <button class="btn-text danger" onclick="window.deleteBook('${b.id}')">🗑️ 删除</button>
                    </td>
                </tr>`;
            }).join('');
        };
        updateList();

        window.editBook = (id) => {
            const book = Store.findBookById(id);
            if (!book) return;
            document.getElementById('edit-id').value = book.id;
            document.getElementById('isbn').value = book.isbn;
            document.getElementById('title').value = book.title;
            document.getElementById('author').value = book.author;
            document.getElementById('cat').value = book.category;
            document.getElementById('press').value = book.press;
            document.getElementById('form-title').innerText = '修改图书信息';
            const btnSave = document.getElementById('btn-save');
            btnSave.innerText = '确认更新';
            btnSave.style.backgroundColor = '#10b981';
            document.getElementById('btn-cancel').style.display = 'inline-block';
        };
        window.deleteBook = (id) => {
            const book = Store.findBookById(id);
            if (!book) return;
            const cps = Store.getCopiesByBookId(id);
            const hasBorrowed = cps.some(c => c.status === 'borrowed');
            if (hasBorrowed) return alert('存在借出中的副本，无法删除');
            if (!confirm('确认删除该图书及其所有副本吗？')) return;
            Store.data.books = Store.data.books.filter(b => b.id !== id);
            const removedCount = cps.length;
            Store.data.copies = Store.data.copies.filter(c => c.bookId !== id);
            Store.addLog('删除', `删除图书 ${book.title} 及其 ${removedCount} 个副本`);
            const editingId = document.getElementById('edit-id').value;
            if (editingId === id) {
                document.getElementById('book-form').reset();
                document.getElementById('edit-id').value = '';
                document.getElementById('form-title').innerText = '录入新书';
                const btnSave = document.getElementById('btn-save');
                btnSave.innerText = '保存图书信息';
                btnSave.style.backgroundColor = '';
                document.getElementById('btn-cancel').style.display = 'none';
            }
            Store.save();
            updateList();
        };

        const resetForm = () => {
            document.getElementById('book-form').reset();
            document.getElementById('edit-id').value = '';
            document.getElementById('form-title').innerText = '录入新书';
            const btnSave = document.getElementById('btn-save');
            btnSave.innerText = '保存图书信息';
            btnSave.style.backgroundColor = '';
            document.getElementById('btn-cancel').style.display = 'none';
        };
        document.getElementById('btn-cancel').onclick = resetForm;

        document.getElementById('book-form').onsubmit = e => {
            e.preventDefault();
            const id = document.getElementById('edit-id').value;
            const isbn = document.getElementById('isbn').value.trim();
            const payload = {
                isbn,
                title: document.getElementById('title').value.trim(),
                author: document.getElementById('author').value.trim(),
                category: document.getElementById('cat').value.trim(),
                press: document.getElementById('press').value.trim()
            };

            if (id) {
                const book = Store.findBookById(id);
                if (book) {
                    const exist = Store.data.books.find(b => b.isbn === isbn && b.id !== id);
                    if (exist) return alert('修改失败：该 ISBN 已被其他书籍使用！');
                    Object.assign(book, payload);
                    Store.save(); alert('图书信息更新成功！'); resetForm();
                }
            } else {
                if (Store.findBook(isbn)) return alert('ISBN已存在');
                Store.data.books.push({ id: uid('bk'), ...payload, createdAt: fmtDate(today()) });
                Store.save(); alert('录入成功'); document.getElementById('book-form').reset();
            }
            updateList();
        };

        document.getElementById('btn-add-copy').onclick = () => {
            const isbn = document.getElementById('cp-isbn').value;
            const bk = Store.findBook(isbn);
            if (!bk) return alert('未找到该ISBN图书，请先录入');
            const count = parseInt(document.getElementById('cp-count').value);
            const loc = document.getElementById('cp-loc').value || '待上架';
            for (let i = 0; i < count; i++) {
                Store.data.copies.push({
                    id: uid('cp'), bookId: bk.id,
                    barcode: Store.nextBarcode(),
                    location: loc, status: 'available'
                });
            }
            Store.save(); updateList(); alert('副本添加成功');
        };
    }

    function renderBorrow() {
        if (elPageTitle) elPageTitle.textContent = '借阅办理';
        const dom = h(`
    <div class="grid">
        <div class="card" style="grid-column:span 6">
            <h2>借阅操作</h2>
            <div style="display:flex;gap:10px;margin-bottom:15px;">
                <button id="mode-borrow" class="primary" style="flex:1">借书模式</button>
                <button id="mode-return" class="secondary" style="flex:1">还书模式</button>
            </div>
            <form class="form" id="flow-form">
                <div id="grp-reader">
                    <label>1. 读者证号</label>
                    <div class="row">
                        <input id="f-card" placeholder="输入/扫描证号" style="flex:1">
                        <button type="button" id="btn-check-r" class="secondary">查询权限</button>
                    </div>
                    <div id="reader-info" style="font-size:13px;color:#666;margin-top:5px;min-height:20px;"></div>
                </div>
                <div id="grp-days">
                    <label>2. 借阅天数 (最大 <span id="max-days" style="font-weight:bold">-</span> 天)</label>
                    <input id="f-days" type="number" min="1" placeholder="请输入借阅天数">
                </div>
                <label>3. 图书条码</label>
                <input id="f-barcode" placeholder="例如 B001" required>
                <button type="submit" id="btn-submit" style="margin-top:15px;width:100%">确认借出</button>
            </form>
        </div>
        <div class="card" style="grid-column:span 6">
            <h2>操作日志 (近30天)</h2>
            <div id="log-box" style="font-size:12px;color:#666;height:400px;overflow-y:auto;"></div>
        </div>
    </div>`);
        elApp.innerHTML = ''; elApp.appendChild(dom);

        let mode = 'borrow';
        const toggle = (m) => {
            mode = m;
            document.getElementById('mode-borrow').className = m === 'borrow' ? 'primary' : 'secondary';
            document.getElementById('mode-return').className = m === 'return' ? 'primary' : 'secondary';
            document.getElementById('grp-reader').style.display = m === 'borrow' ? 'block' : 'none';
            document.getElementById('grp-days').style.display = m === 'borrow' ? 'block' : 'none';
            document.getElementById('f-barcode').placeholder = m === 'borrow' ? '例如 B001 (借出)' : '例如 B001 (归还)';
            document.getElementById('btn-submit').textContent = m === 'borrow' ? '确认借出' : '确认归还';
            document.getElementById('btn-submit').className = m === 'borrow' ? '' : 'success';
        };
        document.getElementById('mode-borrow').onclick = () => toggle('borrow');
        document.getElementById('mode-return').onclick = () => toggle('return');
        toggle('borrow');

        const renderLogs = () => {
            const logs = Store.data.logs || [];
            document.getElementById('log-box').innerHTML = logs.map(l => `
            <div style="padding:8px 0;border-bottom:1px solid #eee;">
                <div style="color:#999">${new Date(l.time).toLocaleString()}</div>
                <div><span class="badge ${l.action === '借阅' ? 'info' : 'success'}">${l.action}</span> ${l.msg}</div>
            </div>
        `).join('');
        };
        renderLogs();

        let currentReader = null;
        document.getElementById('btn-check-r').onclick = () => {
            const c = document.getElementById('f-card').value.trim();
            const r = Store.findReader(c);
            if (!r) return alert('读者不存在');
            if (r.locked) return alert('读者已被锁定');
            currentReader = r;
            document.getElementById('max-days').innerText = r.limits.days;
            document.getElementById('f-days').value = r.limits.days;
            document.getElementById('f-days').max = r.limits.days;
            const loans = Store.data.loans.filter(l => l.readerId === r.id && l.status === 'borrowed');
            document.getElementById('reader-info').innerHTML = `
            <strong>${r.name}</strong> (${r.type}) | 当前在借: ${loans.length}本`;
        };

        document.getElementById('flow-form').onsubmit = e => {
            e.preventDefault();
            const bc = document.getElementById('f-barcode').value.trim();
            const cp = Store.findCopy(bc);
            if (!cp) return alert('无效的图书条码');

            if (mode === 'borrow') {
                if (!currentReader) return alert('请先查询读者信息');
                if (cp.status !== 'available') return alert('该书当前不可借');
                const reqDays = parseInt(document.getElementById('f-days').value);
                const maxDays = currentReader.limits.days;
                if (isNaN(reqDays) || reqDays <= 0) return alert('借阅天数必须大于 0');
                if (reqDays > maxDays) return alert(`借阅天数不能超过 ${maxDays} 天`);

                Store.data.loans.push({
                    id: uid('ln'), copyId: cp.id, bookId: cp.bookId, readerId: currentReader.id,
                    borrowDate: fmtDate(today()), dueDate: fmtDate(addDays(today(), reqDays)),
                    status: 'borrowed', renewCount: 0
                });
                cp.status = 'borrowed';
                Store.addLog('借阅', `${currentReader.name} 借出 ${bc} (期限${reqDays}天)`);
                alert('借出成功');
            } else {
                const ln = Store.data.loans.find(l => l.copyId === cp.id && l.status === 'borrowed');
                if (!ln) return alert('该书未被借出');
                ln.status = 'returned';
                ln.returnDate = fmtDate(today());
                cp.status = 'available';

                if (parseDate(ln.dueDate) < today()) {
                    const diff = Math.ceil((today() - parseDate(ln.dueDate)) / (86400000));
                    const fine = (diff * Store.data.settings.finePerDay).toFixed(2);
                    Store.data.fines.push({
                        id: uid('fn'), readerId: ln.readerId, amount: fine,
                        status: 'unpaid', reason: `借阅超期 ${diff} 天`
                    });
                }
                Store.addLog('归还', `归还图书 ${bc}`);
                alert('归还成功');
            }
            Store.save(); renderLogs();
            document.getElementById('f-barcode').value = '';
        };
    }

    function renderReaders() {
        if (elPageTitle) elPageTitle.textContent = '读者管理';
        if (Auth.user.type !== 'admin') { elApp.innerHTML = '<div class="card">权限不足</div>'; return; }

        const dom = h(`
    <div class="grid">
        <div class="card" style="grid-column:span 5">
            <h2 id="r-title">注册读者</h2>
            <form class="form" id="reader-form">
                <input type="hidden" id="edit-rid">
                <label>姓名</label><input id="rn" required>
                <label>证号</label><input id="rc" required>
                <label>类型</label>
                <select id="rt">
                    <option value="student">学生</option>
                    <option value="staff">教职工</option>
                </select>
                <div class="row" style="margin-top:10px">
                    <button type="submit" id="btn-r-save" style="flex:1">注册</button>
                    <button type="button" id="btn-r-cancel" class="secondary" style="display:none">取消</button>
                </div>
            </form>
        </div>
        <div class="card" style="grid-column:span 7">
            <h2>读者列表</h2>
            <div class="table-container">
                <table class="table"><thead><tr><th>姓名</th><th>证号</th><th>类型</th><th>状态</th><th>操作</th></tr></thead><tbody id="tb-readers"></tbody></table>
            </div>
        </div>
    </div>`);
        elApp.innerHTML = ''; elApp.appendChild(dom);

        const renderList = () => {
            document.getElementById('tb-readers').innerHTML = Store.data.readers.map(r => `
            <tr>
                <td>${r.name}</td><td>${r.card}</td><td>${r.type}</td>
                <td>${r.locked ? '<span class="badge error">锁定</span>' : '<span class="badge success">正常</span>'}</td>
                <td>
                    <button class="btn-text" onclick="window.editReader('${r.id}')">修改</button>
                    <button class="btn-text" onclick="window.toggleLock('${r.id}')">${r.locked ? '解锁' : '锁定'}</button>
                    <button class="btn-text danger" onclick="window.deleteReader('${r.id}')">删除</button>
                </td>
            </tr>
        `).join('');
        };
        renderList();

        window.toggleLock = (id) => { const r = Store.findReaderById(id); r.locked = !r.locked; Store.save(); renderList(); };

        window.editReader = (id) => {
            const r = Store.findReaderById(id);
            if (!r) return;
            document.getElementById('edit-rid').value = r.id;
            document.getElementById('rn').value = r.name;
            document.getElementById('rc').value = r.card;
            document.getElementById('rc').disabled = true;
            document.getElementById('rt').value = r.type;
            document.getElementById('r-title').innerText = '修改信息';
            document.getElementById('btn-r-save').innerText = '更新';
            document.getElementById('btn-r-save').className = 'success';
            document.getElementById('btn-r-cancel').style.display = 'inline-block';
        };
        window.deleteReader = (id) => {
            const r = Store.findReaderById(id);
            if (!r) return;
            if (r.type === 'admin') return alert('系统管理员不可删除');
            const hasBorrowed = Store.data.loans.some(l => l.readerId === id && l.status === 'borrowed');
            if (hasBorrowed) return alert('该读者有借出中的图书，无法删除');
            if (!confirm(`确认删除读者 ${r.name} (${r.card}) 吗？`)) return;
            Store.data.readers = Store.data.readers.filter(x => x.id !== id);
            Store.addLog('删除', `删除读者 ${r.name} (${r.card})`);
            Store.save();
            const editingId = document.getElementById('edit-rid').value;
            if (editingId === id) {
                document.getElementById('reader-form').reset();
                document.getElementById('edit-rid').value = '';
                document.getElementById('rc').disabled = false;
                document.getElementById('r-title').innerText = '注册读者';
                document.getElementById('btn-r-save').innerText = '注册';
                document.getElementById('btn-r-save').className = '';
                document.getElementById('btn-r-cancel').style.display = 'none';
            }
            if (Auth.user && Auth.user.id === id) {
                Auth.logout();
            } else {
                renderList();
            }
        };

        const resetForm = () => {
            document.getElementById('reader-form').reset();
            document.getElementById('edit-rid').value = '';
            document.getElementById('rc').disabled = false;
            document.getElementById('r-title').innerText = '注册读者';
            document.getElementById('btn-r-save').innerText = '注册';
            document.getElementById('btn-r-save').className = '';
            document.getElementById('btn-r-cancel').style.display = 'none';
        };
        document.getElementById('btn-r-cancel').onclick = resetForm;

        document.getElementById('reader-form').onsubmit = e => {
            e.preventDefault();
            const id = document.getElementById('edit-rid').value;
            const name = document.getElementById('rn').value.trim();
            const card = document.getElementById('rc').value.trim();
            const type = document.getElementById('rt').value;

            if (id) {
                const r = Store.findReaderById(id);
                r.name = name; r.type = type; r.limits = Store.data.settings.defaults[type];
                Store.save(); alert('更新成功'); resetForm();
            } else {
                if (Store.findReader(card)) return alert('证号已存在');
                Store.data.readers.push({
                    id: uid('rd'), card, name, type, status: 'active', locked: false,
                    limits: Store.data.settings.defaults[type], passwordHash: '', createdAt: fmtDate(today())
                });
                Store.save(); alert('注册成功'); document.getElementById('reader-form').reset();
            }
            renderList();
        };
    }

    function renderPersonal() {
        if (elPageTitle) elPageTitle.textContent = '个人中心';
        const u = Auth.user;
        const allLoans = Store.getLoans(u.id); // 获取所有历史记录
        const borrowedLoans = allLoans.filter(l => l.status === 'borrowed');
        const fines = Store.data.fines.filter(f => f.readerId === u.id && f.status === 'unpaid');
        const totalUnpaidFine = fines.reduce((sum, f) => sum + parseFloat(f.amount), 0).toFixed(2);

        const dom = h(`
  <div class="grid">
    <div class="card" style="grid-column:span 12">
      <h2>我的借阅 (${borrowedLoans.length} 本)</h2>
      <div style="margin-bottom:10px;font-weight:bold;color:${totalUnpaidFine > 0 ? '#ff4d4f' : '#38a169'}">
        未支付罚金总额：${totalUnpaidFine} 元
      </div>
      <table class="table">
        <thead><tr><th>图书</th><th>借阅日</th><th>应还日</th><th>超期/罚金</th></tr></thead>
        <tbody>
          ${borrowedLoans.map(l => {
            const b = Store.data.books.find(x => x.id === l.bookId);
            const due = parseDate(l.dueDate);
            const now = today();
            let overdueInfo = '正常';
            if (due < now) {
                const diff = Math.ceil((now - due) / (1000 * 3600 * 24));
                const fine = (diff * Store.data.settings.finePerDay).toFixed(2);
                overdueInfo = `<span class="badge error">超期 ${diff} 天 (罚金 ${fine} 元)</span>`;
            }
            return `<tr><td>${b.title}</td><td>${l.borrowDate}</td><td>${l.dueDate}</td><td>${overdueInfo}</td></tr>`;
        }).join('')}
        </tbody>
      </table>
      ${borrowedLoans.length === 0 ? '<p style="color:#999;text-align:center;padding:10px;">暂无借阅</p>' : ''}
    </div>

    <div class="card" style="grid-column:span 6">
      <h2>历史借还记录</h2>
      <div class="table-container" style="max-height:300px;overflow-y:auto;">
      <table class="table">
        <thead><tr><th>图书</th><th>借阅日</th><th>归还日</th><th>状态</th></tr></thead>
        <tbody>
        ${allLoans.slice(-10).reverse().map(l => {
            const b = Store.data.books.find(x => x.id === l.bookId);
            const statusBadge = l.status === 'returned' ? '<span class="badge secondary">已归还</span>' : '<span class="badge error">借出中</span>';
            return `<tr><td>${b.title}</td><td>${l.borrowDate}</td><td>${l.returnDate || '-'}</td><td>${statusBadge}</td></tr>`;
        }).join('')}
        </tbody>
      </table>
      </div>
    </div>

    <div class="card" style="grid-column:span 6">
      <h2>修改密码</h2>
      <form class="form" id="pwd-form">
        <label>新密码</label>
        <input type="password" id="p1" required minlength="4">
        <label>确认新密码</label>
        <input type="password" id="p2" required>
        <button type="submit" class="secondary">确认修改</button>
      </form>
    </div>
  </div>
`);
        elApp.innerHTML = ''; elApp.appendChild(dom);

        document.getElementById('pwd-form').onsubmit = async e => {
            e.preventDefault();
            const p1 = document.getElementById('p1').value;
            const p2 = document.getElementById('p2').value;
            if (p1 !== p2) return alert('两次密码不一致');
            const realUser = Store.data.readers.find(r => r.id === u.id);
            realUser.passwordHash = await sha256(p1);
            Store.save();
            alert('密码修改成功，请重新登录');
            Auth.logout();
        };
    }

    function renderSearch() {
        if (elPageTitle) elPageTitle.textContent = '图书检索';
        const dom = h(`
    <div class="grid">
        <div class="card" style="grid-column:span 12">
            <h2>图书检索</h2>
            <div class="row">
                <input id="q-key" placeholder="书名/作者/ISBN" style="flex-grow:1;"/>
                <button id="q-go">搜索</button>
            </div>
            <div class="table-container" style="margin-top:10px">
                <table class="table">
                    <thead><tr><th>书名</th><th>作者</th><th>ISBN</th><th>库存</th><th>馆藏详情 (条码 | 架位)</th></tr></thead>
                    <tbody id="q-res"></tbody>
                </table>
            </div>
        </div>
        <div class="card" style="grid-column:span 12">
            <h2>随机推荐</h2>
            <div class="row" style="margin-bottom:10px">
                <div style="flex:1;color:#666;font-size:12px">每次展示最多 10 本</div>
                <button id="btn-rec-refresh" class="secondary">换一批</button>
            </div>
            <div class="table-container">
                <table class="table">
                    <thead><tr><th>书名</th><th>作者</th><th>ISBN</th><th>库存</th><th>馆藏详情 (条码 | 架位)</th></tr></thead>
                    <tbody id="rec-res"></tbody>
                </table>
            </div>
        </div>
    </div>`);
        elApp.innerHTML = ''; elApp.appendChild(dom);

        document.getElementById('q-go').onclick = () => {
            const k = document.getElementById('q-key').value.toLowerCase();
            const res = Store.data.books.filter(b =>
                b.title.toLowerCase().includes(k) || b.author.toLowerCase().includes(k) || b.isbn.includes(k)
            );
            document.getElementById('q-res').innerHTML = res.map(b => {
                const allCopies = Store.getCopiesByBookId(b.id);
                const availCopies = allCopies.filter(c => c.status === 'available');
                const statusBadge = availCopies.length > 0
                    ? `<span class="badge success">可借 (${availCopies.length})</span>`
                    : '<span class="badge warn">借完</span>';
                const detailsHtml = availCopies.length > 0 ? availCopies.map(c =>
                    `<div style="font-size:12px;margin-bottom:2px;"><span style="font-weight:bold;color:#0284c7">${c.barcode}</span> <span style="color:#666">[${c.location}]</span></div>`
                ).join('') : '<span style="color:#ccc;font-size:12px">-</span>';
                return `<tr>
                    <td>${b.title}</td><td>${b.author}</td><td>${b.isbn}</td><td>${statusBadge}</td><td>${detailsHtml}</td>
                </tr>`;
            }).join('');
        };

        const pickRandom = () => {
            const arr = Store.data.books.slice();
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
            }
            const n = Math.min(10, arr.length);
            return arr.slice(0, n);
        };
        const renderRecs = () => {
            const list = pickRandom();
            document.getElementById('rec-res').innerHTML = list.map(b => {
                const allCopies = Store.getCopiesByBookId(b.id);
                const availCopies = allCopies.filter(c => c.status === 'available');
                const statusBadge = availCopies.length > 0
                    ? `<span class="badge success">可借 (${availCopies.length})</span>`
                    : '<span class="badge warn">借完</span>';
                const detailsHtml = availCopies.length > 0 ? availCopies.map(c =>
                    `<div style="font-size:12px;margin-bottom:2px;"><span style="font-weight:bold;color:#0284c7">${c.barcode}</span> <span style="color:#666">[${c.location}]</span></div>`
                ).join('') : '<span style="color:#ccc;font-size:12px">-</span>';
                return `<tr>
                    <td>${b.title}</td><td>${b.author}</td><td>${b.isbn}</td><td>${statusBadge}</td><td>${detailsHtml}</td>
                </tr>`;
            }).join('');
        };
        document.getElementById('btn-rec-refresh').onclick = renderRecs;
        renderRecs();
    }

    function renderStats() {
        if (elPageTitle) elPageTitle.textContent = '统计分析';
        const loanCounts = {};
        Store.data.loans.forEach(loan => {
            if (loan.bookId) loanCounts[loan.bookId] = (loanCounts[loan.bookId] || 0) + 1;
        });
        const rankedList = Object.keys(loanCounts).map(bookId => {
            const book = Store.data.books.find(b => b.id === bookId);
            return book ? { title: book.title, author: book.author, count: loanCounts[bookId] } : null;
        }).filter(Boolean).sort((a, b) => b.count - a.count);

        const tableRows = rankedList.slice(0, 10).map((item, index) => `
        <tr><td>${index + 1}</td><td>${item.title}</td><td>${item.author}</td><td>${item.count} 次</td></tr>
    `).join('');

        const dom = h(`
        <div class="card">
            <h2>热门借阅排行榜 (TOP 10)</h2>
            <div class="table-container">
                <table class="table">
                    <thead><tr><th>排名</th><th>书名</th><th>作者</th><th>借阅次数</th></tr></thead>
                    <tbody>${tableRows || '<tr><td colspan="4" style="text-align:center;color:#999;">暂无借阅记录</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    `);
        elApp.innerHTML = ''; elApp.appendChild(dom);
    }

    function renderReports() {
        if (elPageTitle) elPageTitle.textContent = '异常与风险';
        const overdueLoans = Store.data.loans.filter(l => l.status === 'borrowed' && parseDate(l.dueDate) < today());

        const tableRows = overdueLoans.map((l) => {
            const r = Store.data.readers.find(x => x.id === l.readerId);
            const b = Store.data.books.find(x => x.id === l.bookId);
            const diff = Math.ceil((today() - parseDate(l.dueDate)) / (1000 * 3600 * 24));
            const fine = (diff * Store.data.settings.finePerDay).toFixed(2);
            return `<tr>
                <td>${r ? r.name : '未知'} (${r ? r.card : '-'})</td>
                <td>${b ? b.title : '未知'}</td>
                <td>${l.dueDate}</td>
                <td><span class="badge error">超期 ${diff} 天</span></td>
                <td>${fine} 元</td>
            </tr>`;
        }).join('');

        const dom = h(`
        <div class="card">
            <h2>超期未还报告</h2>
            <div class="table-container">
                <table class="table">
                    <thead><tr><th>读者</th><th>图书</th><th>应还日期</th><th>超期天数</th><th>预估罚金</th></tr></thead>
                    <tbody>${tableRows || '<tr><td colspan="5" style="text-align:center;color:#999;">暂无超期记录</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    `);
        elApp.innerHTML = ''; elApp.appendChild(dom);
    }

    function renderSettings() {
        if (elPageTitle) elPageTitle.textContent = '系统设置';
        if (Auth.user.type !== 'admin') { elApp.innerHTML = '<div class="card">权限不足</div>'; return; }

        const dom = h(`
      <div class="grid">
        <div class="card" style="grid-column:span 12">
          <h2>数据迁移 (导入/导出)</h2>
          <div style="background:#f8fafc;padding:20px;border-radius:8px;">
            <div class="row">
               <button id="btn-export" class="primary">⬇️ 导出数据</button>
               <button id="btn-import" class="secondary">⬆️ 导入数据</button>
               <input type="file" id="file-inp" style="display:none" accept=".json">
            </div>
          </div>
        </div>
        <div class="card" style="grid-column:span 12">
          <h2>参数设置</h2>
          <form class="form" id="set-form">
            <label>每日罚金 (元)</label>
            <input id="fine-val" type="number" step="0.1" value="${Store.data.settings.finePerDay}">
            <button type="submit">保存参数</button>
          </form>
        </div>
      </div>
    `);
        elApp.innerHTML = ''; elApp.appendChild(dom);

        document.getElementById('btn-export').onclick = () => {
            const blob = new Blob([JSON.stringify(Store.data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `library_data_${fmtDate(today())}.json`; a.click();
        };

        const fileInp = document.getElementById('file-inp');
        document.getElementById('btn-import').onclick = () => fileInp.click();
        fileInp.onchange = e => {
            const f = e.target.files[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = evt => {
                try {
                    const d = JSON.parse(evt.target.result);
                    if (d.books && d.readers) {
                        if (confirm('导入将覆盖现有数据，确定吗？')) {
                            Store.data = d; Store.save();
                            alert('导入成功，系统将刷新'); location.reload();
                        }
                    } else { alert('文件格式错误'); }
                } catch (err) { alert('文件解析失败'); }
            };
            reader.readAsText(f);
        };

        document.getElementById('set-form').onsubmit = e => {
            e.preventDefault();
            Store.data.settings.finePerDay = parseFloat(document.getElementById('fine-val').value);
            Store.save(); alert('已保存');
        };
    }

    function renderForceChangePassword() {
        if (elPageTitle) elPageTitle.textContent = '激活账号';
        const dom = h(`
        <div style="display:flex;justify-content:center;align-items:center;height:100vh;background:var(--bg-body);">
            <div class="card" style="width:400px;padding:40px 30px; border-top: 4px solid var(--primary); box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);">
                <div style="text-align:center;margin-bottom:30px;">
                    <div style="width:60px;height:60px;background:#eef2ff;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 15px;color:var(--primary);">
                        <span class="material-symbols-rounded" style="font-size:32px;">lock_reset</span>
                    </div>
                    <h2 style="margin:0 0 8px; font-size: 20px; color: var(--text-main);">设置登录密码</h2>
                    <p style="color:var(--text-sub);font-size:14px;line-height:1.5;">
                        你好，<span style="color:var(--primary);font-weight:600">${Auth.user.name}</span><br>
                        这是您首次登录，请设置新的安全密码。
                    </p>
                </div>
                <form class="form" id="force-pwd-form" style="gap:20px;">
                    <div>
                        <label style="margin-bottom:6px;display:block;">新密码</label>
                        <input type="password" id="np1" required minlength="4" placeholder="设置新密码" autofocus style="padding:12px;">
                    </div>
                    <div>
                        <label style="margin-bottom:6px;display:block;">确认密码</label>
                        <input type="password" id="np2" required placeholder="再次输入确认" style="padding:12px;">
                    </div>
                    <button type="submit" class="primary" style="width:100%;margin-top:10px;height:44px;font-size:15px;box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.2);">确认并进入系统</button>
                </form>
                <div style="margin-top:25px;text-align:center;">
                    <button class="btn-text" id="btn-abort-login" style="font-size:13px;color:var(--text-sub);">放弃并退出登录</button>
                </div>
            </div>
        </div>
        `);

        elApp.innerHTML = ''; elApp.appendChild(dom);

        // 绑定退出按钮
        document.getElementById('btn-abort-login').onclick = () => Auth.logout();
        // 绑定表单提交
        document.getElementById('force-pwd-form').onsubmit = async (e) => {
            e.preventDefault();
            const p1 = document.getElementById('np1').value;
            const p2 = document.getElementById('np2').value;

            if (p1 !== p2) {
                alert('两次输入的密码不一致，请重试');
                return;
            }

            const realUser = Store.findReaderById(Auth.user.id);
            if (realUser) {
                realUser.passwordHash = await sha256(p1);

                // 记录日志并保存
                Store.addLog('激活', `用户 ${realUser.name} 激活账号并修改密码`);
                Store.save(); // 保证数据写入本地存储

                // 【修复点 1】更新 Auth.user 对象本身的 passwordHash
                Auth.user.passwordHash = realUser.passwordHash;
                // 【修复点 2】更新本地会话存储，确保 Auth.user 状态是最新的
                localStorage.setItem('lib_user_session', JSON.stringify(Auth.user));

                // 【修复点 3】不再强制登出和刷新，直接导航到 dashboard
                alert('密码设置成功！您将进入系统。');
                location.hash = '#dashboard';
                // 确保侧边栏显示，防止卡在白屏
                const sidebar = document.querySelector('.sidebar');
                if (sidebar) sidebar.style.display = 'flex';
                Router.route(); // 立即执行路由，进入系统

            } else {
                alert('用户数据异常，请联系管理员');
            }
        };
    }

    // ==========================================
    // 5. 启动程序
    // ==========================================
    try {
        await Store.load();
        Router.init();
    } catch (e) {
        console.error("系统启动失败:", e);
        if (elApp) elApp.innerHTML = '<div style="color:red;padding:20px;">系统启动出错，请查看浏览器控制台。</div>';
    }

})();