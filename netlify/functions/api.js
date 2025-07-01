// ไฟล์นี้จะต้องอยู่ในโฟลเดอร์ netlify/functions/ ภายในโปรเจคของคุณ
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// --- ข้อมูลสำคัญที่ต้องตั้งค่าใน Environment Variables ของ Netlify ---
// 1. GOOGLE_SERVICE_ACCOUNT_CREDS_JSON
// 2. EXPENSE_SHEET_ID
// 3. USER_SHEET_ID
// 4. PERMISSION_SHEET_ID

const getServiceAccountAuth = () => {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDS_JSON);
    return new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
};

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'Successful preflight call.' }) };
    }

    try {
        const payload = JSON.parse(event.body);
        const action = payload.action;
        const auth = getServiceAccountAuth();

        // --- Action: Login ---
        if (action === 'login') {
            const { username, password } = payload;
            const doc = new GoogleSpreadsheet(process.env.USER_SHEET_ID, auth);
            await doc.loadInfo();
            const sheet = doc.sheetsByIndex[0];
            const rows = await sheet.getRows();
            
            console.log(`[LOGIN ATTEMPT] Received User: '${username}', Received Pass: '${password}'`);
            console.log("--- STARTING COMPARISON ---");

            const user = rows.find(row => {
                // ดึงข้อมูลจาก Sheet และแปลงเป็น String พร้อมตัดช่องว่าง
                const sheetUser = String(row.get('Cost Center') || '').trim();
                const sheetPass = String(row.get('วันเดือนปี ที่เกิด') || '').trim();

                // ดึงข้อมูลจากที่ผู้ใช้กรอก และแปลงเป็น String พร้อมตัดช่องว่าง
                const inputUser = String(username).trim();
                const inputPass = String(password).trim();

                // เปรียบเทียบข้อมูล
                const isUserMatch = sheetUser.toLowerCase() === inputUser.toLowerCase();
                const isPassMatch = sheetPass === inputPass;

                // พิมพ์ผลการเปรียบเทียบของทุกแถวออกมาให้เราดู
                console.log(`[ROW] Sheet: '${sheetUser}' | '${sheetPass}' <==> Input: '${inputUser}' | '${inputPass}' || User Match? ${isUserMatch}, Pass Match? ${isPassMatch}`);

                return isUserMatch && isPassMatch;
            });

            console.log("--- COMPARISON FINISHED ---");

            if (user) {
                console.log('[RESULT] SUCCESS: Match found!');
                return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Login successful' }) };
            } else {
                console.log('[RESULT] FAILED: No match found in any row.');
                return { statusCode: 401, headers, body: JSON.stringify({ success: false, message: 'Cost Center หรือรหัสผ่านไม่ถูกต้อง' }) };
            }
        }

        // --- Action: Get Data ---
        if (action === 'getData') {
            // ... (ส่วนนี้เหมือนเดิม ไม่ต้องแก้ไข) ...
            const { costCenter } = payload;
            const permDoc = new GoogleSpreadsheet(process.env.PERMISSION_SHEET_ID, auth);
            await permDoc.loadInfo();
            const permSheet = permDoc.sheetsByIndex[0];
            const permRows = await permSheet.getRows();
            const userPermissions = permRows.find(row => String(row.get('Cost Center')||'').trim() === costCenter);
            let accessibleCostCenters = [costCenter];
            if (userPermissions && userPermissions.get('ดูข้อมูลของCost Center อื่นได้')) {
                 const additionalPermissions = userPermissions.get('ดูข้อมูลของCost Center อื่นได้').split(',').map(item => item.trim()).filter(Boolean);
                 accessibleCostCenters = [...new Set([...accessibleCostCenters, ...additionalPermissions])];
            }
            const expenseDoc = new GoogleSpreadsheet(process.env.EXPENSE_SHEET_ID, auth);
            await expenseDoc.loadInfo();
            const expenseSheet = expenseDoc.sheetsByIndex[0];
            const expenseRows = await expenseSheet.getRows();
            await expenseSheet.loadCells('AB2');
            const updateDateCell = expenseSheet.getCellByA1('AB2');
            const lastUpdate = updateDateCell.formattedValue || 'ไม่ระบุ';
            const statusesToFind = ['รอแนบใบเสร็จ', 'รอแนบใบตอบรับ'];
            const filteredData = expenseRows
                .filter(row => {
                    const rowCostCenter = String(row.get('Cost Center')||'').trim();
                    const rowStatus = String(row.get('Status')||'').trim();
                    return accessibleCostCenters.includes(rowCostCenter) && statusesToFind.includes(rowStatus);
                })
                .map(row => row.toObject());
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: filteredData, lastUpdate: lastUpdate }) };
        }

        return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'Invalid action' }) };

    } catch (error) {
        console.error('API Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, message: 'เกิดข้อผิดพลาดภายใน Server: ' + error.message })
        };
    }
};
