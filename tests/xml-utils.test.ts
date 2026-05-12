import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRequestXml,
  buildTopology,
  collectTelemetryNodes,
  encodeValue,
  escapeXml,
  extractEmbeddedPayload,
  extractParameters,
  firstNumber,
  firstString,
  readSystemId,
  redactXml,
} from '../src/xml-utils';

describe('escapeXml', () => {
  it('escapes the five XML special characters', () => {
    assert.equal(
      escapeXml(`hello & <world> "it's" me`),
      'hello &amp; &lt;world&gt; &quot;it&apos;s&quot; me',
    );
  });

  it('is a no-op on safe strings', () => {
    assert.equal(escapeXml('plain text 123'), 'plain text 123');
  });
});

describe('encodeValue', () => {
  it('renders booleans as Hayward-style True/False', () => {
    assert.equal(encodeValue(true, 'bool'), 'True');
    assert.equal(encodeValue(false, 'bool'), 'False');
  });

  it('escapes string values', () => {
    assert.equal(encodeValue('a&b', 'String'), 'a&amp;b');
  });

  it('coerces numerics without escaping', () => {
    assert.equal(encodeValue(42, 'int'), '42');
  });
});

describe('buildRequestXml', () => {
  it('produces a bare <Request> element with parameters, no SOAP envelope', () => {
    const body = buildRequestXml('GetSiteList', [
      { name: 'UserID', dataType: 'String', value: 'u-42' },
    ]);

    assert.equal(
      body,
      '<Request><Name>GetSiteList</Name><Parameters>' +
        '<Parameter name="UserID" dataType="String">u-42</Parameter>' +
        '</Parameters></Request>',
    );
  });

  it('escapes special chars in string values', () => {
    const body = buildRequestXml('X', [
      { name: 'Q', dataType: 'String', value: 'a&b<c' },
    ]);
    assert.match(body, /a&amp;b&lt;c/);
  });

  it('renders booleans as Hayward-style True/False', () => {
    const body = buildRequestXml('X', [
      { name: 'On', dataType: 'bool', value: true },
    ]);
    assert.match(body, /<Parameter name="On" dataType="bool">True<\/Parameter>/);
  });
});

describe('redactXml', () => {
  it('masks Password regardless of attribute order', () => {
    const a = '<Parameter name="Password" dataType="String">hunter2</Parameter>';
    const b = '<Parameter dataType="String" name="Password">hunter2</Parameter>';
    assert.match(redactXml(a), /\*\*\*REDACTED\*\*\*/);
    assert.match(redactXml(b), /\*\*\*REDACTED\*\*\*/);
    assert.doesNotMatch(redactXml(a), /hunter2/);
    assert.doesNotMatch(redactXml(b), /hunter2/);
  });

  it('masks Token parameter and bare <Token> elements', () => {
    const xml =
      '<Parameter name="Token" dataType="String">abc.def</Parameter>' +
      '<Token>xyz.ghi</Token>';
    const out = redactXml(xml);
    assert.doesNotMatch(out, /abc\.def/);
    assert.doesNotMatch(out, /xyz\.ghi/);
  });

  it('leaves UserName and other parameters untouched', () => {
    const xml =
      '<Parameter name="UserName" dataType="String">me@example.com</Parameter>';
    assert.equal(redactXml(xml), xml);
  });

  it('returns falsy input unchanged', () => {
    assert.equal(redactXml(''), '');
  });
});

describe('extractParameters / firstString / firstNumber', () => {
  const sampleLoginResponse = `
    <soap:Envelope>
      <soap:Body>
        <LoginResponse>
          <LoginResult>
            <Parameters>
              <Parameter name="Status" dataType="int">0</Parameter>
              <Parameter name="Token" dataType="String">tok-123</Parameter>
              <Parameter name="UserID" dataType="String">u-42</Parameter>
            </Parameters>
          </LoginResult>
        </LoginResponse>
      </soap:Body>
    </soap:Envelope>
  `;

  it('extracts named parameters', () => {
    const params = extractParameters(sampleLoginResponse);
    assert.equal(firstString(params, 'Token'), 'tok-123');
    assert.equal(firstNumber(params, 'Status'), 0);
    assert.equal(firstString(params, 'Missing'), null);
    assert.equal(firstNumber(params, 'Missing'), null);
  });
});

describe('extractEmbeddedPayload', () => {
  it('finds an inline nested element', () => {
    const xml = `
      <Response>
        <MSPConfig>
          <Backyard><Name>Pool House</Name></Backyard>
        </MSPConfig>
      </Response>
    `;
    const found = extractEmbeddedPayload(xml, ['MSPConfig']);
    assert.ok(found);
    assert.equal(found.Backyard.Name, 'Pool House');
  });

  it('parses XML-string content nested inside a <Parameter>', () => {
    const inner =
      '<MSPConfig><Backyard><Name>Backyard 1</Name></Backyard></MSPConfig>';
    const xml = `
      <Response>
        <Parameters>
          <Parameter name="MSPConfig" dataType="XML">${inner
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')}</Parameter>
        </Parameters>
      </Response>
    `;
    const found = extractEmbeddedPayload(xml, ['MSPConfig']);
    assert.ok(found, 'expected to find MSPConfig payload');
    assert.equal(found.Backyard.Name, 'Backyard 1');
  });

  it('returns undefined when no root matches', () => {
    const xml = '<Response><Other /></Response>';
    assert.equal(extractEmbeddedPayload(xml, ['MSPConfig']), undefined);
  });
});

describe('buildTopology', () => {
  it('handles Body-of-water naming variant and finds equipment', () => {
    const mspNode = {
      Backyard: {
        Name: 'My Backyard',
        'Body-of-water': {
          'System-Id': 10,
          Name: 'Pool',
          Type: 'BOW_POOL',
          Heater: { 'System-Id': 11, Name: 'Pool Heater' },
          Filter: { 'System-Id': 12, Name: 'Pool Pump' },
          'ColorLogic-Light': { 'System-Id': 13, Name: 'Pool Light' },
          Chlorinator: { 'System-Id': 14, Name: 'Salt Cell' },
        },
      },
    };
    const topo = buildTopology(99, mspNode);
    assert.equal(topo.mspSystemId, 99);
    assert.equal(topo.backyardName, 'My Backyard');
    assert.equal(topo.bows.length, 1);
    const bow = topo.bows[0];
    assert.equal(bow.systemId, 10);
    assert.equal(bow.heaters[0].systemId, 11);
    assert.equal(bow.filters[0].systemId, 12);
    assert.equal(bow.lights[0].systemId, 13);
    assert.equal(bow.chlorinators[0].systemId, 14);
  });

  it('handles BodyOfWater + SystemId casing variant', () => {
    const mspNode = {
      Backyard: {
        Name: 'Other',
        BodyOfWater: [
          {
            SystemId: 20,
            Name: 'Spa',
            Type: 'BOW_SPA',
            Heater: { SystemId: 21, Name: 'Spa Heater' },
          },
        ],
      },
    };
    const topo = buildTopology(1, mspNode);
    assert.equal(topo.bows.length, 1);
    assert.equal(topo.bows[0].systemId, 20);
    assert.equal(topo.bows[0].heaters[0].systemId, 21);
  });

  it('skips equipment without a valid system ID', () => {
    const mspNode = {
      Backyard: {
        Name: 'X',
        'Body-of-water': {
          'System-Id': 5,
          Name: 'Pool',
          Heater: [
            { 'System-Id': 0, Name: 'Bad' },
            { 'System-Id': 11, Name: 'Good' },
          ],
        },
      },
    };
    const topo = buildTopology(1, mspNode);
    assert.equal(topo.bows[0].heaters.length, 1);
    assert.equal(topo.bows[0].heaters[0].systemId, 11);
  });
});

describe('readSystemId', () => {
  it('reads System-Id, SystemId, and systemId', () => {
    assert.equal(readSystemId({ 'System-Id': 7 }), 7);
    assert.equal(readSystemId({ SystemId: 8 }), 8);
    assert.equal(readSystemId({ systemId: 9 }), 9);
    assert.equal(readSystemId({}), 0);
  });
});

describe('collectTelemetryNodes', () => {
  it('indexes nodes by their systemId attribute regardless of casing', () => {
    const tree = {
      STATUS: {
        BodyOfWater: [
          { '@_systemId': 10, '@_waterTemp': 78 },
          { '@_SystemId': 20, '@_waterTemp': 102 },
        ],
        Heater: { '@_systemID': 11, '@_temp': 80, '@_enable': 1 },
      },
    };
    const map = collectTelemetryNodes(tree);
    assert.equal(map.size, 3);
    assert.equal(map.get(10)['@_waterTemp'], 78);
    assert.equal(map.get(20)['@_waterTemp'], 102);
    assert.equal(map.get(11)['@_temp'], 80);
  });

  it('merges duplicate ids by shallow-extend', () => {
    const tree = {
      A: { '@_systemId': 1, '@_a': 1 },
      B: { '@_systemId': 1, '@_b': 2 },
    };
    const map = collectTelemetryNodes(tree);
    const merged = map.get(1);
    assert.equal(merged['@_a'], 1);
    assert.equal(merged['@_b'], 2);
  });
});

