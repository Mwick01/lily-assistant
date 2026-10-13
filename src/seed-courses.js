const db = require("./db");

const courses = [
  { alias: "RS", code_a: "CSC4112", code_b: "CSS4212", name: "Research Seminar" },
  { alias: "EM", code_a: "CSC4152", code_b: "CSS4152", name: "Enterprise Modeling" },
  { alias: "CTC", code_a: "CSC4212", code_b: "CSS4222", name: "Compilers and Theory of Computation" },
  { alias: "SOC", code_a: "CSC4222", code_b: "CSS4242", name: "Service Oriented Computing" },
  { alias: "AI", code_a: "CSC4242", code_b: "CSS4232", name: "Artificial Intelligence" },
  { alias: "KE", code_a: "CSC4262", code_b: "CSS4272", name: "Knowledge Engineering" },
  { alias: "RC", code_a: "CSC4282", code_b: "CSS4262", name: "Reconfigurable Computing" },
];

const insert = db.prepare(`
  INSERT INTO courses (alias, code_a, code_b, name)
  VALUES (@alias, @code_a, @code_b, @name)
  ON CONFLICT(alias) DO UPDATE SET
    code_a = excluded.code_a,
    code_b = excluded.code_b,
    name = excluded.name,
    is_active = 1
`);

for (const course of courses) {
  insert.run(course);
}

console.log("Courses seeded successfully.");
