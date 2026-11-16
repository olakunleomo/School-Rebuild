'use strict';
// End-to-end checks: run with `node test.js` (uses a throwaway database).
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
process.env.DB_FILE = path.join(dir, 't.db');
process.env.ADMIN_PASSWORD = 'adminpass1';
const { server } = require('./server.js');
const assert = require('node:assert/strict');

let base;
function client() {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = null; try { data = await res.json(); } catch { /* none */ }
    return { status: res.status, data };
  };
}
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ok -', msg); };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; console.log('  ok -', msg); };

server.listen(0, async () => {
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    const admin = client(), teacher = client(), parent1 = client(), parent2 = client(), anon = client();

    let r = await anon('POST', '/api/login', { username: 'admin', password: 'nope' });
    eq(r.status, 401, 'wrong password is refused');
    r = await anon('GET', '/api/students'); eq(r.status, 401, 'data needs login');
    r = await admin('POST', '/api/login', { username: 'admin', password: 'adminpass1' }); eq(r.status, 200, 'admin can log in');

    r = await admin('PUT', '/api/settings', { schoolName: 'Test Academy', tagline: 'Hello', logoText: 'TA', primaryColor: '#112233', session: '2026/2027', term: '1' });
    eq(r.data.schoolName, 'Test Academy', 'header settings are editable');
    r = await admin('PUT', '/api/settings', { primaryColor: 'red' }); eq(r.status, 400, 'bad colour rejected');

    const classes = (await admin('GET', '/api/classes')).data;
    const subjects = (await admin('GET', '/api/subjects')).data;
    const jss1 = classes.find(c => c.name === 'JSS 1'), jss2 = classes.find(c => c.name === 'JSS 2');
    const math = subjects.find(s => s.name === 'Mathematics'), eng = subjects.find(s => s.name === 'English Language');

    r = await admin('POST', '/api/parents', { name: 'Mrs Ada Obi', phone: '0800', username: 'ada.obi', password: 'parentpw1' });
    const p1 = r.data.id; eq(r.data.credentials.username, 'ada.obi', 'parent registered with login');
    r = await admin('POST', '/api/parents', { name: 'Mr Bayo Lawal' }); const p2 = r.data.id;
    ok(r.data.credentials.password.length >= 8, 'password auto-generated when left blank');
    const p2cred = r.data.credentials;

    r = await admin('POST', '/api/students', { first_name: 'Chidi', last_name: 'Obi', gender: 'Male', class_id: jss1.id, parent_id: p1, password: 'studentpw1' });
    const sA = r.data.id; ok(r.data.admission_no.startsWith('STU-'), 'admission number auto-generated');
    r = await admin('POST', '/api/students', { first_name: 'Dayo', last_name: 'Lawal', gender: 'Female', class_id: jss1.id, parent_id: p2, admission_no: 'ADM-77' });
    const sB = r.data.id;
    r = await admin('POST', '/api/students', { first_name: 'X', last_name: 'Y', class_id: jss1.id, admission_no: 'ADM-77' }); eq(r.status, 409, 'duplicate admission number rejected');

    r = await admin('PUT', '/api/students/' + sA, { last_name: 'Obiora' });
    r = await admin('GET', '/api/students/' + sA); eq([r.data.last_name, r.data.first_name, r.data.parent_id], ['Obiora', 'Chidi', p1], 'edit one field, others stay');

    r = await admin('POST', '/api/teachers', { name: 'Mr Tunde Ade', username: 'tunde', password: 'teachpw1', assignments: [{ class_id: jss1.id, subject_id: math.id }] });
    const tId = r.data.id; eq(r.status, 200, 'teacher registered with assignment');

    r = await teacher('POST', '/api/login', { username: 'tunde', password: 'teachpw1' }); eq(r.status, 200, 'teacher logs in');
    r = await teacher('GET', '/api/students'); eq(r.status, 403, 'teacher cannot open the student register');
    r = await teacher('GET', `/api/gradesheet?class_id=${jss1.id}&subject_id=${eng.id}&term=1`); eq(r.status, 403, 'teacher blocked from unassigned subject');
    r = await teacher('GET', `/api/gradesheet?class_id=${jss1.id}&subject_id=${math.id}&term=2`); eq(r.status, 403, 'term 2 locked until admin opens it');
    r = await teacher('PUT', '/api/gradesheet', { class_id: jss1.id, subject_id: math.id, term: 1, rows: [{ student_id: sA, ca: 31, exam: 50 }] }); eq(r.status, 400, 'CA above 30 rejected');
    r = await teacher('PUT', '/api/gradesheet', { class_id: jss1.id, subject_id: math.id, term: 1, rows: [{ student_id: sA, ca: 20, exam: 71 }] }); eq(r.status, 400, 'exam above 70 rejected');

    const put = (term, a, b) => teacher('PUT', '/api/gradesheet', { class_id: jss1.id, subject_id: math.id, term, rows: [{ student_id: sA, ca: a[0], exam: a[1] }, { student_id: sB, ca: b[0], exam: b[1] }] });
    r = await put(1, [20, 50], [10, 30]); eq(r.status, 200, 'term 1 grades saved');
    await admin('PUT', '/api/settings', { term: '2' }); r = await put(2, [25, 40], [15, 35]); eq(r.status, 200, 'term 2 grades saved after admin opens term 2');
    await admin('PUT', '/api/settings', { term: '3' }); r = await put(3, [30, 60], [20, 45]); eq(r.status, 200, 'term 3 grades saved');
    r = await put(3, [28, 60], [20, 45]);
    r = await teacher('GET', `/api/gradesheet?class_id=${jss1.id}&subject_id=${math.id}&term=3`);
    eq(r.data.students.find(s => s.id === sA).ca, 28, 'grades can be corrected in place');
    await put(3, [30, 60], [20, 45]);

    r = await parent1('POST', '/api/login', { username: 'ada.obi', password: 'parentpw1' }); eq(r.status, 200, 'parent logs in');
    r = await parent1('GET', `/api/results/${sA}?session=2026/2027&term=1`);
    eq([r.data.subjects[0].ca, r.data.subjects[0].exam, r.data.subjects[0].total, r.data.subjects[0].grade], [20, 50, 70, 'A'], 'term 1 result: CA 20 + Exam 50 = 70 (A)');
    ok(r.data.cumulative === undefined, 'term 1 carries no cumulative');
    r = await parent1('GET', `/api/results/${sA}?session=2026/2027&term=2`); ok(r.data.cumulative === undefined && r.data.subjects[0].total === 65, 'term 2 carries no cumulative');
    r = await parent1('GET', `/api/results/${sA}?session=2026/2027&term=3`);
    const m = r.data.subjects[0];
    eq([m.t1, m.t2, m.t3, m.cumulative, m.average, m.grade], [70, 65, 90, 225, 75, 'A'], 'term 3 carries cumulative of all three terms');
    eq([r.data.cumulative.total, r.data.cumulative.average, r.data.cumulative.position, r.data.summary.position], [225, 75, 1, 1], 'cumulative total, average and position');
    r = await parent1('GET', `/api/results/${sB}?session=2026/2027&term=3`); eq(r.status, 403, 'parent cannot see another family\'s child');
    r = await parent2('POST', '/api/login', { username: p2cred.username, password: p2cred.password });
    r = await parent2('GET', `/api/results/${sB}?session=2026/2027&term=3`);
    eq([r.data.cumulative.position, r.data.subjects[0].average], [2, 51.67], 'second child ranked 2nd with average 51.67');
    r = await parent1('PUT', '/api/students/' + sA, { class_id: jss2.id }); eq(r.status, 403, 'parent cannot edit anything');
    r = await parent1('POST', `/api/users/1/reset`, { password: 'hacked123' }); eq(r.status, 403, 'parent cannot reset passwords');
    r = await teacher('POST', `/api/users/1/reset`, { password: 'hacked123' }); eq(r.status, 403, 'teacher cannot reset passwords');

    r = await admin('POST', '/api/promote', { student_ids: [sA, sB], to_class_id: jss2.id }); eq(r.data.moved, 2, 'promote two students to JSS 2');
    r = await admin('GET', '/api/students/' + sA); eq(r.data.class_name, 'JSS 2', 'student is now in JSS 2');
    r = await parent1('GET', `/api/results/${sA}?session=2026/2027&term=3`);
    eq([r.data.class_name, r.data.cumulative.total], ['JSS 1', 225], 'old results still show JSS 1 after promotion');
    r = await admin('GET', `/api/results/class/${jss1.id}?session=2026/2027&term=3`); eq(r.data.length, 2, 'admin can pull a whole class for printing');
    r = await admin('POST', '/api/promote', { student_ids: [sB], graduate: true }); eq(r.data.moved, 1, 'graduate a student');

    const users = (await admin('GET', '/api/users')).data;
    const pu = users.find(u => u.username === 'ada.obi');
    r = await admin('POST', `/api/users/${pu.id}/reset`, { password: 'newsecret9' }); eq(r.data.password, 'newsecret9', 'admin resets a password');
    r = await parent1('GET', '/api/my/children'); eq(r.status, 401, 'old session ends after reset');
    r = await anon('POST', '/api/login', { username: 'ada.obi', password: 'parentpw1' }); eq(r.status, 401, 'old password no longer works');
    r = await anon('POST', '/api/login', { username: 'ADA.OBI', password: 'newsecret9' }); eq(r.status, 200, 'new password works (username not case sensitive)');
    r = await admin('PUT', '/api/users/' + pu.id, { active: false });
    r = await anon('POST', '/api/login', { username: 'ada.obi', password: 'newsecret9' }); eq(r.status, 401, 'deactivated account cannot log in');

    r = await admin('DELETE', '/api/classes/' + jss1.id); eq(r.status, 409, 'class with grades cannot be deleted');
    r = await admin('DELETE', '/api/students/' + sA); eq(r.status, 200, 'admin can delete a student');
    console.log(`\nAll ${passed} checks passed.`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\nFAILED:', e.message); process.exitCode = 1;
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(process.exitCode); }
});