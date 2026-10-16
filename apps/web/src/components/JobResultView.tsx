import type { JobResult } from '@starter/contracts';
import { formatDecimal, formatDuration, formatInteger, formatPercent } from '../lib/format';

export function JobResultView({ result }: { result: JobResult }) {
  const stats: [label: string, value: string][] = [
    ['Words', formatInteger(result.wordCount)],
    ['Unique words', formatInteger(result.uniqueWordCount)],
    ['Sentences', formatInteger(result.sentenceCount)],
    ['Paragraphs', formatInteger(result.paragraphCount)],
    ['Characters', formatInteger(result.characterCount)],
    ['Average word length', `${formatDecimal(result.averageWordLength)} characters`],
    ['Average sentence length', `${formatDecimal(result.averageSentenceLength)} words`],
    ['Lexical diversity', formatPercent(result.lexicalDiversity)],
    ['Reading time', formatDuration(result.readingTimeSeconds)],
    ['Algorithm version', result.algorithmVersion],
  ];

  return (
    <section className="results" aria-labelledby="results-heading">
      <h3 id="results-heading">Results</h3>
      <dl className="stats">
        {stats.map(([label, value]) => (
          <div key={label} className="stat">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {result.topTerms.length > 0 ? (
        <table className="terms">
          <caption>Top terms</caption>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Term</th>
              <th scope="col">Count</th>
            </tr>
          </thead>
          <tbody>
            {result.topTerms.map((entry, index) => (
              <tr key={entry.term}>
                <td>{index + 1}</td>
                <th scope="row">{entry.term}</th>
                <td>{formatInteger(entry.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No significant terms found (stop words, numbers and very short words are ignored).</p>
      )}

      <dl className="checksum">
        <dt>SHA-256 checksum of the submitted text</dt>
        <dd>
          <code>{result.checksumSha256}</code>
        </dd>
      </dl>
    </section>
  );
}
