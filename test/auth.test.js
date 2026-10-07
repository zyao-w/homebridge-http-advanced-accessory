const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveBearerToken } = require("../auth.js");

describe("resolveBearerToken", () => {
    const ENV_NAME = "HHAA_TEST_TOKEN";

    afterEach(() => {
        delete process.env[ENV_NAME];
    });

    test.each`
        input              | expected
        ${undefined}       | ${""}
        ${null}            | ${""}
        ${""}              | ${""}
        ${42}              | ${""}
        ${"abc"}           | ${"abc"}
        ${"  abc\n"}       | ${"abc"}
    `("literal $input resolves to '$expected'", ({ input, expected }) => {
        expect(resolveBearerToken(input)).toBe(expected);
    });

    test("reads and trims an environment variable", () => {
        process.env[ENV_NAME] = "  secret-from-env \n";
        expect(resolveBearerToken("env:" + ENV_NAME)).toBe("secret-from-env");
    });

    test("throws when the environment variable is missing", () => {
        expect(() => resolveBearerToken("env:" + ENV_NAME)).toThrow(ENV_NAME);
    });

    describe("file source", () => {
        let dir;

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "hhaa-"));
        });

        afterEach(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        test("reads and trims a file", () => {
            const file = path.join(dir, "token");
            fs.writeFileSync(file, "secret-from-file\r\n");
            expect(resolveBearerToken("file:" + file)).toBe("secret-from-file");
        });

        test("throws when the file does not exist", () => {
            expect(() => resolveBearerToken("file:" + path.join(dir, "missing"))).toThrow("cannot read file");
        });

        test("throws when the file is empty", () => {
            const file = path.join(dir, "empty");
            fs.writeFileSync(file, "  \n");
            expect(() => resolveBearerToken("file:" + file)).toThrow("is empty");
        });
    });
});
