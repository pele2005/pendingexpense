// ไฟล์นี้จะต้องอยู่ในโฟลเดอร์ netlify/functions/ ภายในโปรเจคของคุณ
// npm install google-spreadsheet

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// --- ข้อมูลสำคัญที่ต้องตั้งค่าใน Environment Variables ของ Netlify ---
// 1. GOOGLE_SERVICE_ACCOUNT_CREDS_JSON: เนื้อหาทั้งหมดของไฟล์ JSON ที่ได้จาก Google Cloud
// 2. EXPENSE_SHEET_ID: 1RG-ShsZKfscKYIbMfVKSvV_7YBUvkG7b8MQNK8r_2TM
// 3. USER_SHEET_ID: 1E-1fKvOG2Yd88RM3WmTAKEzB-Ve1uBuFyDXKGc-ehXY
// 4. PERMISSION_SHEET_ID: 1LXyGjplIU6WZPF-0Ty10aOO_Dl2Kq_lO7EqdhjtZl80

// ฟังก์ชันสำหรับสร้าง Service Account Credentials
const getServiceAccountAuth = () => {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDS_JSON);
    return new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
};

// ฟังก์ชันหลักของ API ที่จะถูกเรียกโดย Netlify
exports.handler = async (event, context) => {
    // อนุญาตให้เรียกใช้จากทุกโดเมน (CORS)
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    
    // สำหรับ preflight request ของเบราว์เซอร์
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ message: 'Successful preflight call.' }),
        };
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
            
            // ค้นหาผู้ใช้ (เปรียบเทียบแบบ String เพื่อความแน่นอน)
            const user = rows.find(row => 
                row.get('Cost Center')?.trim() === String(username).trim() && 
                row.get('วันเดือนปี ที่เกิด')?.trim() === String(password).trim()
            );

            if (user) {
                return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Login successful' }) };
            } else {
                return { statusCode: 401, headers, body: JSON.stringify({ success: false, message: 'Cost Center หรือรหัสผ่านไม่ถูกต้อง' }) };
            }
        }

        // --- Action: Get Data ---
        if (action === 'getData') {
            const { costCenter } = payload;

            // 1. ดึงข้อมูลสิทธิ์ (Permission)
            const permDoc = new GoogleSpreadsheet(process.env.PERMISSION_SHEET_ID, auth);
            await permDoc.loadInfo();
            const permSheet = permDoc.sheetsByIndex[0];
            const permRows = await permSheet.getRows();
            const userPermissions = permRows.find(row => row.get('Cost Center')?.trim() === costCenter);
            
            let accessibleCostCenters = [costCenter]; // ตัวเองดูได้เสมอ
            if (userPermissions && userPermissions.get('ดูข้อมูลของCost Center อื่นได้')) {
                 const additionalPermissions = userPermissions.get('ดูข้อมูลของCost Center อื่นได้').split(',').map(item => item.trim()).filter(Boolean);
                 accessibleCostCenters = [...new Set([...accessibleCostCenters, ...additionalPermissions])]; // ใช้ Set เพื่อไม่ให้มีค่าซ้ำ
            }
            
            // 2. ดึงข้อมูลค่าใช้จ่ายทั้งหมด
            const expenseDoc = new GoogleSpreadsheet(process.env.EXPENSE_SHEET_ID, auth);
            await expenseDoc.loadInfo();
            const expenseSheet = expenseDoc.sheetsByIndex[0];
            const expenseRows = await expenseSheet.getRows();
            
            // 3. ดึงวันที่อัพเดทจากเซลล์ AB2
            await expenseSheet.loadCells('AB2');
            const updateDateCell = expenseSheet.getCellByA1('AB2');
            const lastUpdate = updateDateCell.formattedValue || 'ไม่ระบุ';

            // 4. กรองข้อมูลตามเงื่อนไข
            const statusesToFind = ['รอแนบใบเสร็จ', 'รอแนบใบตอบรับ'];
            const filteredData = expenseRows
                .filter(row => {
                    const rowCostCenter = row.get('Cost Center')?.trim();
                    const rowStatus = row.get('Status')?.trim();
                    return accessibleCostCenters.includes(rowCostCenter) && statusesToFind.includes(rowStatus);
                })
                .map(row => row.toObject()); // แปลงเป็น Object ธรรมดาเพื่อส่งกลับ

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true, data: filteredData, lastUpdate: lastUpdate })
            };
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
